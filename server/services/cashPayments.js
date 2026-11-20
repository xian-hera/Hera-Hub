// Cash Payments — drawer cash from Shopify POS (2026-11-19, Hera —
// claude/CASH_PAYMENTS_SPEC.md; drawer-based since 2026-11-20).
//
// Every store closes each POS cash drawer (R1, R2… — Shopify calls them by a
// number such as "71") at night. Per location per day Hub keeps:
//   Expected = Σ over the location's drawers of (Ending cash − cash at open)
//              (the $150 float stays in the drawer, so it is taken out —
//              Hera 2026-11-20)
//   Removed  = Σ cash removed from the drawers during the day ("Remove cash")
// and per drawer: cash at open, Ending cash, Removed (cash_drawer_days).
//
// Source: Admin GraphQL pointOfSaleDevicePaymentSessions (one session = one
// drawer from open to close). Needs scope read_cash_tracking; cash data only
// for POS Pro locations. A session belongs to the Toronto day it was OPENED.
//   Ending cash = cashCountedAtClose (falls back to closingBalance).
//   Removed     = CashAdjustmentActivity of type ADJUSTMENT with a negative
//                 amount (sign NOT documented by Shopify — check against one
//                 real Remove cash before trusting it).
//   A drawer whose session has no Ending cash (no cash counting, e.g. OTT03's
//   drawer 133) is skipped.
//
// (Before 2026-11-20 this file fetched System = ShopifyQL cash net payments per
// location; Hera chose to drop System completely. The columns stay, unused.)
//
// When: every day at 03:10 Toronto (jobs/cashPaymentsScheduler.js), shortly
// after boot, and right after a Starting date is saved. Each run fetches every
// day from the Starting date to yesterday not fetched yet (cash_payment_days).
// A day with a drawer still open is retried on the next run (for up to 3 days,
// then stored without it). A fetched day is never fetched again.
// No Starting date → nothing is fetched or stored. Deposited days never change.

const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');

const TZ = 'America/Toronto';
const HQ = 'HQ';
const CHUNK_DAYS = 7;          // days per sessions query
const WAIT_OPEN_DAYS = 3;      // retry a day with an open drawer this many days

function torontoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Toronto calendar day of a timestamp.
function torontoDay(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

// 'YYYY-MM-DD' ± n days (UTC noon, so DST can't shift the day).
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

// Midnight of a Toronto day as an ISO timestamp with its offset (DST-safe).
function torontoMidnight(iso) {
  const noon = new Date(`${iso}T12:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(noon).find(p => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part ? part.value : '');
  const off = m ? `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}` : '-05:00';
  return `${iso}T00:00:00${off}`;
}

async function getStartingDate(db = pool) {
  const r = await db.query(`SELECT value FROM app_settings WHERE key = 'cash_starting_date'`);
  const v = r.rows[0] ? r.rows[0].value : null;
  return isIsoDate(v) ? v : null;
}

async function activeLocations(db = pool) {
  const r = await db.query(
    `SELECT location_name FROM location_map WHERE is_active = TRUE AND location_name <> $1`,
    [HQ]
  );
  return r.rows.map(x => x.location_name);
}

// '1451.79' / 1451.79 → 145179
function toCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const money = (m) => (m && m.amount !== undefined && m.amount !== null ? toCents(m.amount) : null);

const SESSIONS = `query CashSessions($q: String!, $after: String) {
  pointOfSaleDevicePaymentSessions(first: 25, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id status openingTime closingTime
      location { name }
      cashDrawer { id name }
      cashCountedAtOpen { amount }
      cashCountedAtClose { amount }
      closingBalance { amount }
      cashActivities(first: 30) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename time cash { amount } ... on CashAdjustmentActivity { type } }
      }
    }
  }
}`;
const MORE_ACTIVITIES = `query MoreCashActivities($id: ID!, $after: String) {
  pointOfSaleDevicePaymentSession(id: $id) {
    cashActivities(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename time cash { amount } ... on CashAdjustmentActivity { type } }
    }
  }
}`;

// Cash removed during a session (positive cents).
function removedOf(activities) {
  let removed = 0;
  for (const a of activities) {
    if (a && a.__typename === 'CashAdjustmentActivity' && a.type === 'ADJUSTMENT') {
      const c = money(a.cash);
      if (c !== null && c < 0) removed += -c;
    }
  }
  return removed;
}

// All sessions opened from..to (Toronto days, inclusive).
async function fetchSessions(from, to) {
  const q = `opening_time:>='${torontoMidnight(from)}' opening_time:<'${torontoMidnight(addDays(to, 1))}'`;
  const out = [];
  let after = null;
  for (;;) {
    const data = await gql(SESSIONS, { q, after });
    const conn = data && data.pointOfSaleDevicePaymentSessions;
    if (!conn) break;
    for (const s of conn.nodes || []) {
      let acts = (s.cashActivities && s.cashActivities.nodes) || [];
      let page = s.cashActivities && s.cashActivities.pageInfo;
      while (page && page.hasNextPage) {
        const more = await gql(MORE_ACTIVITIES, { id: s.id, after: page.endCursor });
        const c = more && more.pointOfSaleDevicePaymentSession && more.pointOfSaleDevicePaymentSession.cashActivities;
        if (!c) break;
        acts = acts.concat(c.nodes || []);
        page = c.pageInfo;
      }
      out.push({ ...s, activities: acts });
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// Consecutive runs of days, each at most CHUNK_DAYS long.
function toChunks(days) {
  const chunks = [];
  let cur = [];
  for (const d of days) {
    if (cur.length && (addDays(cur[cur.length - 1], 1) !== d || cur.length >= CHUNK_DAYS)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(d);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// sessions → Map day → Map location → Map drawerId → drawer totals; plus days with an open drawer.
function groupSessions(sessions) {
  const byDay = new Map();
  const openDays = new Set();
  for (const s of sessions) {
    const day = torontoDay(s.openingTime);
    if (String(s.status || '').toUpperCase() === 'OPEN') { openDays.add(day); continue; }
    const loc = s.location && s.location.name;
    const drawer = s.cashDrawer || {};
    const ending = money(s.cashCountedAtClose) ?? money(s.closingBalance);
    if (!loc || !drawer.id || ending === null) continue; // no cash counting on this drawer
    if (!byDay.has(day)) byDay.set(day, new Map());
    const locs = byDay.get(day);
    if (!locs.has(loc)) locs.set(loc, new Map());
    const drawers = locs.get(loc);
    const cur = drawers.get(drawer.id) || { name: drawer.name || drawer.id, opening: 0, ending: 0, removed: 0, sessions: 0 };
    cur.opening += money(s.cashCountedAtOpen) || 0;
    cur.ending += ending;
    cur.removed += removedOf(s.activities);
    cur.sessions += 1;
    drawers.set(drawer.id, cur);
  }
  return { byDay, openDays };
}

async function syncOnce() {
  const start = await getStartingDate();
  if (!start) return { skipped: 'no starting date' };
  const today = torontoToday();
  const yesterday = addDays(today, -1);
  if (start > yesterday) return { skipped: 'starting date not passed yet' };

  const done = await pool.query(
    `SELECT to_char(pay_date, 'YYYY-MM-DD') AS d FROM cash_payment_days WHERE pay_date BETWEEN $1::date AND $2::date`,
    [start, yesterday]
  );
  const have = new Set(done.rows.map(r => r.d));
  const missing = [];
  for (let d = start; d <= yesterday; d = addDays(d, 1)) if (!have.has(d)) missing.push(d);
  if (!missing.length) return { fetchedDays: 0 };

  const locations = await activeLocations();
  let fetchedDays = 0;
  for (const chunk of toChunks(missing)) {
    const sessions = await fetchSessions(chunk[0], chunk[chunk.length - 1]);
    const { byDay, openDays } = groupSessions(sessions);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const day of chunk) {
        // A drawer still open: wait for it (a few days at most).
        if (openDays.has(day) && day >= addDays(today, -WAIT_OPEN_DAYS)) continue;
        const locs = byDay.get(day) || new Map();
        for (const loc of locations) {
          const drawers = locs.get(loc) || new Map();
          let expected = 0;
          let removed = 0;
          for (const [drawerId, d] of drawers) {
            expected += d.ending - d.opening;
            removed += d.removed;
            await client.query(
              `INSERT INTO cash_drawer_days (location, pay_date, drawer_id, drawer_name, opening_cents, ending_cents, removed_cents, sessions)
               VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (location, pay_date, drawer_id) DO UPDATE SET drawer_name = EXCLUDED.drawer_name,
                 opening_cents = EXCLUDED.opening_cents, ending_cents = EXCLUDED.ending_cents,
                 removed_cents = EXCLUDED.removed_cents, sessions = EXCLUDED.sessions`,
              [loc, day, drawerId, d.name, d.opening, d.ending, d.removed, d.sessions]
            );
          }
          // A deposited day keeps its amounts.
          await client.query(
            `INSERT INTO cash_payments (location, pay_date, expected_cents, removed_cents) VALUES ($1, $2::date, $3, $4)
             ON CONFLICT (location, pay_date) DO UPDATE SET expected_cents = EXCLUDED.expected_cents,
               removed_cents = EXCLUDED.removed_cents, updated_at = NOW()
             WHERE cash_payments.deposit_id IS NULL`,
            [loc, day, expected, removed]
          );
        }
        await client.query(
          `INSERT INTO cash_payment_days (pay_date, fetched_at) VALUES ($1::date, NOW())
           ON CONFLICT (pay_date) DO UPDATE SET fetched_at = NOW()`,
          [day]
        );
        fetchedDays += 1;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { fetchedDays };
}

// One run at a time; a second call while one runs waits for the same run.
let running = null;
function syncSystemAmounts(reason = '') {
  if (!running) {
    running = syncOnce()
      .then((r) => {
        if (r.fetchedDays) console.log(`[cash-payments] drawer cash fetched for ${r.fetchedDays} day(s)${reason ? ` (${reason})` : ''}`);
        return r;
      })
      .catch((e) => {
        console.error(`[cash-payments] fetch failed${reason ? ` (${reason})` : ''}:`, e.message);
        return { error: e.message };
      })
      .finally(() => { running = null; });
  }
  return running;
}

function isSyncRunning() { return !!running; }

// ─── deposits ───────────────────────────────────────────────────────────────
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Creates a deposit for `location` dated today (Toronto) inside the given client
// (transaction). Same base already used this year → the first one becomes -A,
// later ones -B, -C… → returns the new deposit row.
async function createDeposit(client, location, note, { isTest = false, createdAt = null } = {}) {
  const day = createdAt ? torontoDay(createdAt) : torontoToday();
  const [y, m, d] = day.split('-').map(Number);
  const base = `${location}-${MONTHS[m - 1]}-${String(d).padStart(2, '0')}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cash_deposit|${base}|${y}`]).catch(() => {});
  const same = await client.query(
    `SELECT id, suffix FROM cash_deposits WHERE title_base = $1 AND title_year = $2 ORDER BY id`,
    [base, y]
  );
  let suffix = null;
  if (same.rows.length) {
    if (same.rows.length === 1 && !same.rows[0].suffix) {
      await client.query(`UPDATE cash_deposits SET suffix = 'A' WHERE id = $1`, [same.rows[0].id]);
    }
    suffix = String.fromCharCode(65 + same.rows.length); // 1 existing → B, 2 → C …
  }
  const ins = await client.query(
    `INSERT INTO cash_deposits (location, title_base, title_year, suffix, note, created_at, is_test)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7) RETURNING *`,
    [location, base, y, suffix, note || null, createdAt, isTest]
  );
  return ins.rows[0];
}

module.exports = {
  createDeposit,
  syncSystemAmounts, isSyncRunning, getStartingDate, torontoToday, torontoDay, addDays, isIsoDate, activeLocations,
  // exported for tests
  groupSessions, removedOf, torontoMidnight,
};
