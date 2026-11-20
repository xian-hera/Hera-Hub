// Cash Payments — System amounts from Shopify (2026-11-19, Hera —
// claude/CASH_PAYMENTS_SPEC.md).
//
// System = Shopify's cash net payments of one POS location on one day,
// ROUNDED the way the cash was (rounded_net_payments — Canadian cash is
// rounded to 5 cents; changed 2026-11-20, Hera: plain net_payments made almost
// every day a few-cents Mismatch). The unrounded net_payments is kept too
// (unrounded_cents) for the "Rounded from …" tooltip. Diffs use the rounded
// System. POS "Remove cash" is a drawer adjustment, not a payment, so it is
// NOT in these numbers (confirmed by Shopify support 2026-11-20). Same
// numbers as Hera's report "All Stores Payments by gateway summary" (FROM
// payments … transaction_kind IN sale/change/capture/refund), Payment gateway
// "Cash", but grouped by day so many days come back in one query.
//
// When: every day at 03:10 Toronto (jobs/cashPaymentsScheduler.js), shortly
// after boot, and right after a Starting date is saved. Each run fetches every
// day from the Starting date to yesterday that hasn't been fetched yet
// (cash_payment_days), so a missed night catches up by itself. A fetched day
// is never fetched again (Hera: once a day has passed its data is final).
// No Starting date → nothing is fetched or stored.
//
// A location with no cash that day gets System 0 (its row shows grey and
// needs no entry). Only active, non-HQ locations of the shared location map
// get rows; names Shopify returns that aren't in the map are ignored.
//
// Needs the read_reports scope (shopifyqlQuery).

const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');

const TZ = 'America/Toronto';
const HQ = 'HQ';
const CHUNK_DAYS = 40; // 40 days × ~20 locations stays under the 1000-row LIMIT

function torontoToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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

const SHOPIFYQL = `query CashPayments($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}`;

// → Map 'LOC|YYYY-MM-DD' → { rounded, net } cents, for days from..to (inclusive).
async function fetchCashByDay(from, to) {
  const q = `FROM payments
  SHOW net_payments, rounded_net_payments
  WHERE transaction_kind IN ('sale', 'change', 'capture', 'refund')
    AND payment_gateway = 'Cash'
  GROUP BY pos_location_name, day
  SINCE ${from} UNTIL ${to}
  ORDER BY day ASC, pos_location_name ASC
  LIMIT 1000`;
  const data = await gql(SHOPIFYQL, { q });
  const res = data && data.shopifyqlQuery;
  const errs = res && res.parseErrors;
  if (Array.isArray(errs) && errs.length) {
    throw new Error(`ShopifyQL: ${errs.map(e => (typeof e === 'string' ? e : (e && (e.message || JSON.stringify(e))))).join('; ')}`);
  }
  const table = res && res.tableData;
  if (!table) throw new Error('ShopifyQL returned no table');
  const cols = (table.columns || []).map(c => c.name);
  const iLoc = cols.indexOf('pos_location_name');
  const iDay = cols.indexOf('day');
  const iAmt = cols.indexOf('net_payments');
  const iRnd = cols.indexOf('rounded_net_payments');
  let rows = table.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch (e) { rows = []; } }
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    // rows can be objects keyed by column name or plain arrays.
    const loc = Array.isArray(row) ? row[iLoc] : row.pos_location_name;
    const day = String((Array.isArray(row) ? row[iDay] : row.day) || '').slice(0, 10);
    const amt = Array.isArray(row) ? row[iAmt] : row.net_payments;
    const rnd = Array.isArray(row) ? (iRnd >= 0 ? row[iRnd] : null) : row.rounded_net_payments;
    if (!loc || !isIsoDate(day)) continue;
    const key = `${loc}|${day}`;
    const net = toCents(amt);
    const rounded = rnd === null || rnd === undefined || rnd === '' ? net : toCents(rnd);
    const cur = out.get(key) || { rounded: 0, net: 0 };
    out.set(key, { rounded: cur.rounded + rounded, net: cur.net + net });
  }
  if (Array.isArray(rows) && rows.length >= 1000) {
    console.warn(`[cash-payments] ${from}..${to}: 1000 rows returned — some may be missing; lower CHUNK_DAYS`);
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

async function syncOnce() {
  const start = await getStartingDate();
  if (!start) return { skipped: 'no starting date' };
  const yesterday = addDays(torontoToday(), -1);
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
    const amounts = await fetchCashByDay(chunk[0], chunk[chunk.length - 1]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const day of chunk) {
        for (const loc of locations) {
          const a = amounts.get(`${loc}|${day}`) || { rounded: 0, net: 0 };
          // An archived row keeps its System amount.
          await client.query(
            `INSERT INTO cash_payments (location, pay_date, system_cents, unrounded_cents) VALUES ($1, $2::date, $3, $4)
             ON CONFLICT (location, pay_date) DO UPDATE SET system_cents = EXCLUDED.system_cents,
               unrounded_cents = EXCLUDED.unrounded_cents, updated_at = NOW()
             WHERE cash_payments.archived_at IS NULL`,
            [loc, day, a.rounded, a.net]
          );
        }
        await client.query(
          `INSERT INTO cash_payment_days (pay_date, fetched_at) VALUES ($1::date, NOW())
           ON CONFLICT (pay_date) DO UPDATE SET fetched_at = NOW()`,
          [day]
        );
      }
      await client.query('COMMIT');
      fetchedDays += chunk.length;
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
        if (r.fetchedDays) console.log(`[cash-payments] System amounts fetched for ${r.fetchedDays} day(s)${reason ? ` (${reason})` : ''}`);
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

module.exports = {
  syncSystemAmounts, isSyncRunning, getStartingDate, torontoToday, addDays, isIsoDate, activeLocations,
};
