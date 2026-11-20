// Operation › Cash Payments (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
// Mounted at /api/cash-payments.
//
// Every store puts the day's cash (minus the float) in an envelope with the
// amount written on it. Once a week the finance person collects the envelopes
// and enters, per day, Declared (written on the envelope) and Counted (what
// she counted). System = Shopify cash net payments (services/cashPayments.js).
//
//   GET    /settings            starting date, groups, today / yesterday (Toronto)
//   PUT    /starting-date       { date } → saves, then fetches missing days
//   GET    /groups              [{ id, name, locations }]
//   POST   /groups              { name, locations }
//   PUT    /groups/:id          { name, locations }
//   DELETE /groups/:id
//   GET    /groups/my           → { identified, groupId } (0 = Admin, null = not chosen)
//   PUT    /groups/my           { groupId }
//   DELETE /groups/my           Log out: forget this account's group
//   GET    /rows                ?locations=A,B&from&to&filter&sort&page&pageSize
//   PUT    /row                 { location, date, declared?, counted? } (amount strings / null)
//   PUT    /note                { location, date, note } ('' = delete)
//   POST   /archive             { location, from, to }
//
// Like accountMemory.js, the /groups/my routes never answer 401: no account →
// { identified: false } and the page falls back to localStorage.

const express = require('express');
const router = express.Router();
const { pool } = require('../database/init');
const { getAccountId } = require('../accountAuth');
const CP = require('../services/cashPayments');
// Preview & Test Mode (2026-11-19, TEMPORARY — remove after live testing):
// fake data before the Starting date. See services/cashPaymentsTest.js.
const T = require('../services/cashPaymentsTest');
router.use('/test-mode', T.router);

const ADMIN_ID = 0;
const NOTE_MAX = 1000;
const MAX_CENTS = 10000000000; // $100,000,000 — anything bigger is a typo

// ─── helpers ────────────────────────────────────────────────────────────────

async function readGroups(db = pool) {
  const r = await db.query(`SELECT value FROM app_settings WHERE key = 'cash_user_groups'`);
  const v = r.rows[0] ? r.rows[0].value : [];
  return Array.isArray(v) ? v : [];
}

async function writeGroups(groups, db = pool) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('cash_user_groups', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(groups)]
  );
}

// Location order for Cash Payments (Hera): MTL, OTT, QC, EDM, CAL, then any
// other prefix A→Z; the number part ascending.
const PREFIX_ORDER = ['MTL', 'OTT', 'QC', 'EDM', 'CAL'];
function locationKey(name) {
  const m = /^([A-Za-z]+)(\d*)$/.exec(String(name || ''));
  const prefix = m ? m[1].toUpperCase() : String(name || '');
  const num = m && m[2] ? parseInt(m[2], 10) : 0;
  const idx = PREFIX_ORDER.indexOf(prefix);
  return { rank: idx === -1 ? PREFIX_ORDER.length : idx, prefix, num };
}
function compareLocations(a, b) {
  const ka = locationKey(a);
  const kb = locationKey(b);
  if (ka.rank !== kb.rank) return ka.rank - kb.rank;
  if (ka.prefix !== kb.prefix) return ka.prefix < kb.prefix ? -1 : 1;
  if (ka.num !== kb.num) return ka.num - kb.num;
  return String(a).localeCompare(String(b));
}

// '1,234.5' / 1234.5 / '' / null → cents | null. Throws on anything else.
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s$]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) throw new Error(`"${v}" is not an amount like 1234.56`);
  const cents = Math.round(Number(s) * 100);
  if (cents > MAX_CENTS) throw new Error(`"${v}" is too large`);
  return cents;
}

// The three differences; null when one side is missing.
function diffsOf(r) {
  const s = Number(r.system_cents);
  const d = r.declared_cents === null ? null : Number(r.declared_cents);
  const c = r.counted_cents === null ? null : Number(r.counted_cents);
  return {
    declaredVsSystem: d === null ? null : d - s,
    countedVsDeclared: d === null || c === null ? null : c - d,
    countedVsSystem: c === null ? null : c - s,
  };
}

// Row → what the page needs. Status rules (Hera):
//   noCash   System 0 → grey row, nothing to enter, never Pending
//   pending  Declared or Counted missing
//   matched  all three differences 0
//   mismatch at least one difference
//   archived after Save & Archive (shown instead of the above)
// Filter pills: Collected = both entered; Mismatch = entered and at least one
// difference (archived rows included — Audit can still find them); Pending =
// not complete; Archived = archived.
function shapeRow(r) {
  const system = Number(r.system_cents);
  const declared = r.declared_cents === null ? null : Number(r.declared_cents);
  const counted = r.counted_cents === null ? null : Number(r.counted_cents);
  const diffs = diffsOf(r);
  const noCash = system === 0;
  const collected = declared !== null && counted !== null;
  const mismatch = collected && (diffs.declaredVsSystem !== 0 || diffs.countedVsDeclared !== 0 || diffs.countedVsSystem !== 0);
  const archived = !!r.archived_at;
  const pending = !archived && !noCash && !collected;
  let status = 'pending';
  if (archived) status = 'archived';
  else if (noCash && !collected) status = 'nocash';
  else if (collected) status = mismatch ? 'mismatch' : 'matched';
  return {
    location: r.location,
    date: r.d,
    system,
    declared,
    counted,
    diffs,
    note: r.note || '',
    archived,
    archivedAt: r.archived_at,
    noCash,
    status,
    flags: { collected, pending, mismatch, archived },
  };
}

// from/to clamped to Starting date … yesterday. → { from, to } or null (empty).
function clampRange(from, to, start, yesterday) {
  let f = CP.isIsoDate(from) ? from : start;
  let t = CP.isIsoDate(to) ? to : yesterday;
  if (f < start) f = start;
  if (t > yesterday) t = yesterday;
  return f > t ? null : { from: f, to: t };
}

// start = first day Collect / Audit may show: the Starting date, or — while
// Preview & Test Mode is on and populated — the first fake day.
async function rangeContext() {
  const realStart = await CP.getStartingDate();
  const test = await T.testInfo();
  const today = CP.torontoToday();
  const start = test.on && test.from ? test.from : realStart;
  return { start, realStart, test, today, yesterday: CP.addDays(today, -1) };
}

// ─── settings ───────────────────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const { start, realStart, test, today, yesterday } = await rangeContext();
    const last = await pool.query(`SELECT to_char(MAX(pay_date), 'YYYY-MM-DD') AS d FROM cash_payment_days`);
    res.json({
      startingDate: realStart,
      rangeStart: start, // first day Collect / Audit may show (null = nothing yet)
      test,              // Preview & Test Mode { on, from, allowed } — temporary
      today,
      yesterday,
      lastFetchedDay: last.rows[0] ? last.rows[0].d : null,
      fetching: CP.isSyncRunning(),
      groups: await readGroups(),
    });
  } catch (e) {
    console.error('GET /api/cash-payments/settings error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/starting-date', async (req, res) => {
  try {
    const date = req.body && req.body.date;
    if (!CP.isIsoDate(date)) return res.status(400).json({ error: 'Pick a date.' });
    // A future date is allowed (2026-11-19): Preview & Test Mode is offered until it comes.
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('cash_starting_date', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(date)]
    );
    await T.maintain(); // date reached → fake rows go before the real fetch
    CP.syncSystemAmounts('starting date saved'); // fire and forget
    res.json({ startingDate: date, fetching: true });
  } catch (e) {
    console.error('PUT /api/cash-payments/starting-date error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── user groups ────────────────────────────────────────────────────────────

function cleanGroupInput(body, groups, selfId) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw new Error('The group needs a name.');
  if (name.length > 40) throw new Error('Group name is too long (max 40).');
  if (name.toLowerCase() === 'admin') throw new Error('“Admin” is reserved.');
  if (groups.some(g => Number(g.id) !== Number(selfId) && String(g.name).toLowerCase() === name.toLowerCase())) {
    throw new Error(`There is already a group called “${name}”.`);
  }
  const locations = Array.from(new Set((Array.isArray(body && body.locations) ? body.locations : [])
    .map(l => String(l || '').trim()).filter(l => l && l !== 'HQ'))).sort(compareLocations);
  if (!locations.length) throw new Error('Pick at least one location.');
  return { name, locations };
}

router.get('/groups', async (req, res) => {
  try {
    res.json({ groups: await readGroups() });
  } catch (e) {
    console.error('GET /api/cash-payments/groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const groups = await readGroups();
    let clean;
    try { clean = cleanGroupInput(req.body, groups, null); } catch (e) { return res.status(400).json({ error: e.message }); }
    const id = groups.reduce((m, g) => Math.max(m, Number(g.id) || 0), 0) + 1;
    const next = [...groups, { id, ...clean }];
    await writeGroups(next);
    res.json({ groups: next });
  } catch (e) {
    console.error('POST /api/cash-payments/groups error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── my group (registered before '/groups/:id') ─────────────────────────────

router.get('/groups/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, groupId: null });
    const r = await pool.query(`SELECT group_id FROM cash_account_groups WHERE account_id = $1`, [accountId]);
    if (!r.rows[0]) return res.json({ identified: true, groupId: null });
    const gid = Number(r.rows[0].group_id);
    const groups = await readGroups();
    const valid = gid === ADMIN_ID || groups.some(g => Number(g.id) === gid);
    res.json({ identified: true, groupId: valid ? gid : null });
  } catch (e) {
    console.error('GET /api/cash-payments/groups/my error:', e);
    res.json({ identified: false, groupId: null });
  }
});

router.put('/groups/my', async (req, res) => {
  try {
    const gid = parseInt(req.body && req.body.groupId, 10);
    const groups = await readGroups();
    if (!(gid === ADMIN_ID || groups.some(g => Number(g.id) === gid))) return res.status(400).json({ error: 'Unknown group.' });
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(
      `INSERT INTO cash_account_groups (account_id, group_id, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET group_id = $2, updated_at = NOW()`,
      [accountId, gid]
    );
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('PUT /api/cash-payments/groups/my error:', e);
    res.json({ identified: false, success: false });
  }
});

router.delete('/groups/my', async (req, res) => {
  try {
    const accountId = await getAccountId(req);
    if (!accountId) return res.json({ identified: false, success: false });
    await pool.query(`DELETE FROM cash_account_groups WHERE account_id = $1`, [accountId]);
    res.json({ identified: true, success: true });
  } catch (e) {
    console.error('DELETE /api/cash-payments/groups/my error:', e);
    res.json({ identified: false, success: false });
  }
});

router.put('/groups/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const groups = await readGroups();
    if (!groups.some(g => Number(g.id) === id)) return res.status(404).json({ error: 'Group not found.' });
    let clean;
    try { clean = cleanGroupInput(req.body, groups, id); } catch (e) { return res.status(400).json({ error: e.message }); }
    const next = groups.map(g => (Number(g.id) === id ? { id, ...clean } : g));
    await writeGroups(next);
    res.json({ groups: next });
  } catch (e) {
    console.error('PUT /api/cash-payments/groups/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Accounts that had picked a deleted group choose again on their next visit.
router.delete('/groups/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const groups = await readGroups();
    const next = groups.filter(g => Number(g.id) !== id);
    await writeGroups(next);
    await pool.query(`DELETE FROM cash_account_groups WHERE group_id = $1`, [id]);
    res.json({ groups: next });
  } catch (e) {
    console.error('DELETE /api/cash-payments/groups/:id error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── rows ───────────────────────────────────────────────────────────────────

const FILTERS = ['all', 'collected', 'pending', 'mismatch', 'archived'];

router.get('/rows', async (req, res) => {
  try {
    const rangeCtx = await rangeContext();
    const { start, today, yesterday } = rangeCtx;
    const empty = { counts: { all: 0, collected: 0, pending: 0, mismatch: 0, archived: 0 }, rows: [], total: 0, page: 1, pages: 1 };
    if (!start) return res.json({ ...empty, noStartingDate: true, today, yesterday });
    const locations = String(req.query.locations || '').split(',').map(s => s.trim()).filter(Boolean);
    const range = clampRange(req.query.from, req.query.to, start, yesterday);
    if (!locations.length || !range) return res.json({ ...empty, startingDate: start, today, yesterday, range });

    const r = await pool.query(
      `SELECT location, to_char(pay_date, 'YYYY-MM-DD') AS d, system_cents, declared_cents, counted_cents, note, archived_at
         FROM cash_payments
        WHERE location = ANY($1::text[]) AND pay_date BETWEEN $2::date AND $3::date`,
      [locations, range.from, range.to]
    );
    const all = r.rows.map(shapeRow);
    const counts = {
      all: all.length,
      collected: all.filter(x => x.flags.collected).length,
      pending: all.filter(x => x.flags.pending).length,
      mismatch: all.filter(x => x.flags.mismatch).length,
      archived: all.filter(x => x.flags.archived).length,
    };
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    let list = filter === 'all' ? all : all.filter(x => x.flags[filter]);

    // Location (MTL, OTT, QC, EDM, CAL; number ascending), then date —
    // sort=asc oldest first (Collect), otherwise newest first (Audit).
    const asc = req.query.sort === 'asc';
    list.sort((a, b) => compareLocations(a.location, b.location)
      || (asc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));

    const pageSize = Math.max(0, parseInt(req.query.pageSize, 10) || 0); // 0 = everything
    const total = list.length;
    const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    if (pageSize) list = list.slice((page - 1) * pageSize, page * pageSize);

    res.json({ counts, rows: list, total, page, pages, startingDate: start, today, yesterday, range, fetching: CP.isSyncRunning(), testMode: rangeCtx.test.on });
  } catch (e) {
    console.error('GET /api/cash-payments/rows error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function loadRow(location, date) {
  const r = await pool.query(
    `SELECT location, to_char(pay_date, 'YYYY-MM-DD') AS d, system_cents, declared_cents, counted_cents, note, archived_at
       FROM cash_payments WHERE location = $1 AND pay_date = $2::date`,
    [location, date]
  );
  return r.rows[0] || null;
}

// Declared / Counted. Only the fields sent are changed; '' / null clears one.
router.put('/row', async (req, res) => {
  try {
    const { location, date } = req.body || {};
    if (!location || !CP.isIsoDate(date)) return res.status(400).json({ error: 'Missing location or date.' });
    const row = await loadRow(location, date);
    if (!row) return res.status(404).json({ error: 'This day has no System amount yet.' });
    if (row.archived_at) return res.status(409).json({ error: 'This day is archived and can’t be changed.' });
    if (Number(row.system_cents) === 0) return res.status(409).json({ error: 'No cash this day — nothing to enter.' });
    const sets = [];
    const params = [location, date];
    try {
      if (Object.prototype.hasOwnProperty.call(req.body, 'declared')) {
        params.push(parseAmount(req.body.declared));
        sets.push(`declared_cents = $${params.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'counted')) {
        params.push(parseAmount(req.body.counted));
        sets.push(`counted_cents = $${params.length}`);
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (sets.length) {
      await pool.query(
        `UPDATE cash_payments SET ${sets.join(', ')}, updated_at = NOW()
          WHERE location = $1 AND pay_date = $2::date AND archived_at IS NULL`,
        params
      );
    }
    res.json({ row: shapeRow(await loadRow(location, date)) });
  } catch (e) {
    console.error('PUT /api/cash-payments/row error:', e);
    res.status(500).json({ error: e.message });
  }
});

// One note per row; can be added / edited / deleted any time (also archived rows).
router.put('/note', async (req, res) => {
  try {
    const { location, date } = req.body || {};
    if (!location || !CP.isIsoDate(date)) return res.status(400).json({ error: 'Missing location or date.' });
    const note = String((req.body && req.body.note) || '').trim();
    if (note.length > NOTE_MAX) return res.status(400).json({ error: `Note is too long (max ${NOTE_MAX}).` });
    const r = await pool.query(
      `UPDATE cash_payments SET note = $3, updated_at = NOW() WHERE location = $1 AND pay_date = $2::date`,
      [location, date, note || null]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Row not found.' });
    res.json({ row: shapeRow(await loadRow(location, date)) });
  } catch (e) {
    console.error('PUT /api/cash-payments/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Save & Archive: every not-yet-archived row of one location in the range.
// Refused while any of them is still Pending.
router.post('/archive', async (req, res) => {
  try {
    const { location } = req.body || {};
    if (!location) return res.status(400).json({ error: 'Choose a location.' });
    const { start, yesterday } = await rangeContext();
    if (!start) return res.status(400).json({ error: 'Set a Starting date first.' });
    const range = clampRange(req.body.from, req.body.to, start, yesterday);
    if (!range) return res.status(400).json({ error: 'Nothing to archive in this date range.' });
    const pend = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cash_payments
        WHERE location = $1 AND pay_date BETWEEN $2::date AND $3::date AND archived_at IS NULL
          AND system_cents <> 0 AND (declared_cents IS NULL OR counted_cents IS NULL)`,
      [location, range.from, range.to]
    );
    if (pend.rows[0].n > 0) {
      return res.status(400).json({ error: `${pend.rows[0].n} day(s) are still Pending. Enter Declared and Counted for every day first.`, pending: pend.rows[0].n });
    }
    const r = await pool.query(
      `UPDATE cash_payments SET archived_at = NOW(), updated_at = NOW()
        WHERE location = $1 AND pay_date BETWEEN $2::date AND $3::date AND archived_at IS NULL`,
      [location, range.from, range.to]
    );
    res.json({ archived: r.rowCount });
  } catch (e) {
    console.error('POST /api/cash-payments/archive error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.compareLocations = compareLocations;
module.exports.parseAmount = parseAmount;
module.exports.shapeRow = shapeRow;
