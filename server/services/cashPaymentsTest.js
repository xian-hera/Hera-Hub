// Cash Payments — Preview & Test Mode (2026-11-19, Hera — TEMPORARY: remove
// once Cash Payments has been tested live; see claude/CASH_PAYMENTS_SPEC.md).
//
// Lets Hera try Collect / Audit before the real Starting date has come.
//   - Offered only while the Starting date is empty or in the future.
//   - On → "Populate Data": every active non-HQ location gets 2–3 fake
//     drawers and fake days for the 30 days ending yesterday (2026-11-20:
//     drawer-based — Ending, Removed per drawer). The 23 older days have
//     Counted (mostly Matched, some Mismatch, some with Receipted removed or a
//     note, some No cash); the oldest 16 are put into weekly fake deposits;
//     the last 7 days are left Pending. Populating again replaces all fake data.
//   - While it stays on, every new past day gets fake Pending rows (03:10 run,
//     and whenever the page loads).
//   - Off, or the Starting date reached (today or earlier) → every fake row is
//     deleted and the mode turns off by itself.
// Fake rows are normal cash_payments rows with is_test = TRUE, so every page
// works on them as usual. cash_payment_days is never touched, so the real
// fetch later is not affected.
//
// To remove: drop this file, its two lines in routes/cashPayments.js and
// jobs/cashPaymentsScheduler.js, the switch in CashSettings.js, the banner
// in CashPaymentsShell.js; DELETE FROM cash_payments WHERE is_test; delete
// app_settings 'cash_test_mode'.

const express = require('express');
const { pool } = require('../database/init');
const CP = require('./cashPayments');

const KEY = 'cash_test_mode';
const DAYS = 30;
const PENDING_DAYS = 7;
const DEPOSITED_DAYS = 16;
const FLOAT = 15000; // $150 at open, like the real drawers

async function readState(db = pool) {
  const r = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [KEY]);
  const v = r.rows[0] ? r.rows[0].value : null;
  return { on: !!(v && v.on), from: v && CP.isIsoDate(v.from) ? v.from : null };
}
async function writeState(state, db = pool) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [KEY, JSON.stringify(state)]
  );
}
async function clearTestRows(db = pool) {
  const r = await db.query(`DELETE FROM cash_payments WHERE is_test = TRUE`);
  await db.query(`DELETE FROM cash_drawer_days WHERE is_test = TRUE`);
  await db.query(`DELETE FROM cash_deposits WHERE is_test = TRUE`);
  return r.rowCount;
}

// The mode may only exist while the Starting date is empty or in the future.
async function allowed() {
  const start = await CP.getStartingDate();
  return !start || start > CP.torontoToday();
}

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (list) => list[rnd(0, list.length - 1)];
const NOTES = [
  'Test note: envelope amount re-checked with the store manager.',
  'Test note: short — one bill was stuck in the drawer.',
  'Test note: over — float was not taken out before counting.',
  'Test note: manager says a refund was given in cash.',
];

const round5 = (c) => Math.round(c / 5) * 5;

// Fake drawers of a location: 2–3 numbers, stable per location (e.g. 901, 902).
function fakeDrawers(loc, index) {
  const n = 2 + (index % 2);
  return Array.from({ length: n }, (_, i) => ({ id: `test-${loc}-${i + 1}`, name: String(900 + index * 3 + i + 1) }));
}

// One fake day of one location. kind: 'filled' | 'pending'
function fakeDay(kind, drawers) {
  const noCash = Math.random() < 0.05;
  const lines = drawers.map((d) => {
    const sales = noCash || Math.random() < 0.15 ? 0 : round5(rnd(2000, 90000));
    const removed = !noCash && sales > 0 && Math.random() < 0.15 ? round5(rnd(200, 3000)) : 0;
    // expectedCashAtClose (2026-11-27): usually what the store counted, ~10 % off a little.
    const ending = FLOAT + sales - removed;
    const expectedClose = sales > 0 && Math.random() < 0.1 ? ending + (Math.random() < 0.5 ? -1 : 1) * round5(rnd(5, 500)) : ending;
    return { ...d, opening: FLOAT, ending, expectedClose, removed };
  });
  const expected = lines.reduce((a, l) => a + l.ending - l.opening, 0);
  const posExpected = lines.reduce((a, l) => a + l.expectedClose - l.opening, 0);
  const removed = lines.reduce((a, l) => a + l.removed, 0);
  let counted = null;
  let receipted = null;
  let note = null;
  if (kind === 'filled') { // 2026-11-27: No cash days need Counted too (0)
    counted = expected;
    if (Math.random() < 0.25) {
      counted = Math.max(0, expected + (Math.random() < 0.5 ? -1 : 1) * round5(rnd(5, 900)));
      if (Math.random() < 0.5) note = pick(NOTES);
    }
    if (removed > 0) {
      const r = Math.random();
      if (r < 0.6) receipted = removed;
      else if (r < 0.8) receipted = Math.max(0, removed - round5(rnd(100, 1000)));
    }
  }
  return { lines, expected, posExpected, removed, counted, receipted, note };
}

// Never overwrites a real row.
async function insertDay(client, loc, day, f, depositId) {
  for (const l of f.lines) {
    await client.query(
      `INSERT INTO cash_drawer_days (location, pay_date, drawer_id, drawer_name, opening_cents, ending_cents, removed_cents, sessions, is_test, expected_close_cents)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, 1, TRUE, $8) ON CONFLICT (location, pay_date, drawer_id) DO NOTHING`,
      [loc, day, l.id, l.name, l.opening, l.ending, l.removed, l.expectedClose]
    );
  }
  await client.query(
    `INSERT INTO cash_payments (location, pay_date, expected_cents, removed_cents, counted_cents, receipted_cents, note, deposit_id, is_test, pos_expected_cents)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, TRUE, $9) ON CONFLICT (location, pay_date) DO NOTHING`,
    [loc, day, f.expected, f.removed, f.counted, f.receipted, f.note, depositId, f.posExpected]
  );
}

async function insertRows(client, locations, days, kindOf, depositedUntil) {
  const sorted = [...locations].sort();
  for (const [index, loc] of sorted.entries()) {
    const drawers = fakeDrawers(loc, index);
    let week = [];
    const flush = async () => {
      if (!week.length) return;
      // Fake deposit made the morning after the week's last day.
      const createdAt = `${CP.addDays(week[week.length - 1].day, 1)}T16:${String(rnd(10, 59))}:00Z`;
      const dep = await CP.createDeposit(client, loc, Math.random() < 0.3 ? 'Test deposit note.' : '', { isTest: true, createdAt });
      for (const w of week) await insertDay(client, loc, w.day, w.f, dep.id);
      week = [];
    };
    for (const day of days) {
      const f = fakeDay(kindOf(day), drawers);
      if (kindOf(day) === 'filled' && depositedUntil && day <= depositedUntil) {
        week.push({ day, f });
        if (week.length === 7 || day === depositedUntil) await flush();
      } else {
        await insertDay(client, loc, day, f, null);
      }
    }
    await flush();
  }
}

async function populate() {
  if (!(await allowed())) throw Object.assign(new Error('Preview & Test Mode is only available before the Starting date.'), { status: 400 });
  const state = await readState();
  if (!state.on) throw Object.assign(new Error('Turn Preview & Test Mode on first.'), { status: 400 });
  const yesterday = CP.addDays(CP.torontoToday(), -1);
  const from = CP.addDays(yesterday, -(DAYS - 1));
  const days = [];
  for (let d = from; d <= yesterday; d = CP.addDays(d, 1)) days.push(d);
  const pendingFrom = CP.addDays(yesterday, -(PENDING_DAYS - 1));
  const depositedUntil = CP.addDays(from, DEPOSITED_DAYS - 1);
  const locations = await CP.activeLocations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await clearTestRows(client);
    await insertRows(client, locations, days, (d) => (d >= pendingFrom ? 'pending' : 'filled'), depositedUntil);
    await writeState({ on: true, from }, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { from, to: yesterday, locations: locations.length };
}

// Keeps the mode in step with time. Called by the 03:10 job and on page loads.
//   Starting date reached → delete fake rows, mode off.
//   Mode on and populated → fake Pending rows for every new past day.
let busy = null;
function maintain() {
  if (!busy) {
    busy = (async () => {
      const state = await readState();
      if (!state.on && !state.from) return state;
      if (!(await allowed())) {
        const n = await clearTestRows();
        await writeState({ on: false, from: null });
        if (n) console.log(`[cash-payments] Starting date reached — ${n} test row(s) deleted, Preview & Test Mode off`);
        return { on: false, from: null };
      }
      if (state.on && state.from) {
        const r = await pool.query(`SELECT to_char(MAX(pay_date), 'YYYY-MM-DD') AS d FROM cash_payments WHERE is_test = TRUE`);
        const last = r.rows[0] && r.rows[0].d;
        const yesterday = CP.addDays(CP.torontoToday(), -1);
        if (last && last < yesterday) {
          const days = [];
          for (let d = CP.addDays(last, 1); d <= yesterday; d = CP.addDays(d, 1)) days.push(d);
          const locations = await CP.activeLocations();
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await insertRows(client, locations, days, () => 'pending', null);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          } finally {
            client.release();
          }
        }
      }
      return state;
    })()
      .catch((e) => { console.error('[cash-payments] test mode upkeep failed:', e.message); return null; })
      .finally(() => { busy = null; });
  }
  return busy;
}

// For the pages: { on, from, allowed }. `from` = first fake day (null until
// Populate Data); Collect / Audit start there while the mode is on.
async function testInfo() {
  await maintain();
  const state = await readState();
  return { ...state, allowed: await allowed() };
}

// ─── routes, mounted at /api/cash-payments/test-mode ────────────────────────
const router = express.Router();

// PUT { on } — off deletes every fake row.
router.put('/', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    if (on) {
      if (!(await allowed())) return res.status(400).json({ error: 'Preview & Test Mode is only available before the Starting date.' });
      const state = await readState();
      await writeState({ on: true, from: state.from });
      return res.json({ test: await testInfo() });
    }
    const n = await clearTestRows();
    await writeState({ on: false, from: null });
    res.json({ test: await testInfo(), deleted: n });
  } catch (e) {
    console.error('PUT /api/cash-payments/test-mode error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/populate', async (req, res) => {
  try {
    const r = await populate();
    res.json({ ...r, test: await testInfo() });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST /api/cash-payments/test-mode/populate error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, testInfo, maintain };
