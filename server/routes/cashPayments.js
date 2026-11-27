// Operation › Cash Payments (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
// Mounted at /api/cash-payments.
//
// Every store puts the day's cash (minus the float) in an envelope. Once a
// week finance collects the envelopes and enters, per location per day,
// Counted (what she counted) and, optionally, Receipted removed (removed cash
// backed by receipts). Expected / Removed come from the POS drawers
// (services/cashPayments.js). Make Deposit locks days into a deposit.
// (2026-11-20: System / Declared / Save & Archive replaced — Hera.)
//
//   GET    /settings            starting date, groups, today / yesterday (Toronto)
//   PUT    /starting-date       { date } → saves, then fetches missing days
//   GET    /groups              [{ id, name, locations }]
//   POST   /groups              { name, locations }
//   PUT    /groups/:id          { name, locations }
//   DELETE /groups/:id
//   GET    /groups/my           → { identified, groupId } (0 = Admin, null = not chosen)
//   PUT    /groups/my           { groupId, pin? } — Admin needs the Admin password
//   DELETE /groups/my           Log out: forget this account's group
//   PUT    /admin-pin           { pin } — set / change the Admin password
//   GET    /rows                ?locations=A,B&from&to&filter&sort&page&pageSize (rows carry their drawers)
//   POST   /review              { items: [{ location, date }], reviewed } — Audit › Discrepancy (2026-11-27)
//   GET    /thresholds · PUT /thresholds { diff1, diff2, diff3 } — Significant discrepancy (2026-11-27)
//   GET    /deposits/:id/rows   the days of one deposit (Audit › Deposits, expanded) (2026-11-27)
//   PUT    /row                 { location, date, counted?, receipted? } (amount strings / null)
//   PUT    /note                { location, date, note } ('' = delete)
//   POST   /deposits            { location, dates: [...], note? } — Make Deposit
//   GET    /deposits            ?locations=A,B&from&to — deposits holding a day in the range
//   PUT    /deposits/:id/note   { note }
//
// Like accountMemory.js, the /groups/my routes never answer 401: no account →
// { identified: false } and the page falls back to localStorage.

const express = require('express');
const crypto = require('crypto');
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

// Row → what the page needs. 2026-11-27 (Hera) layout — per drawer and per day:
//   Expected      Shopify's expectedCashAtClose − cash at open   (pos_expected_cents; null = unknown)
//   StoreCounted  cashCountedAtClose − cash at open               (expected_cents — old name kept)
//   Counted       entered by finance (day total only)
//   Removed       cash removed; Receipted = removed cash backed by receipts (entered, day total only)
//   diff1 = StoreCounted − Expected   (each drawer, and the day total)
//   diff2 = Counted − StoreCounted    (day total, once Counted is entered)
//   diff3 = Receipted − Removed       (day total, once Receipted is entered)
// Status (2026-11-27): deposited · collected (Counted entered) · pending.
// (2026-11-20 version: Expected = Σ (Ending − open), Diff = Counted − Expected,
//  statuses matched / mismatch / nocash — replaced.)
// Flags (filter pills / counts):
//   Collect: all · pending · collected · diffs (any diff ≠ 0) · deposited · notdeposited
//   Audit › Discrepancy: dall (diffs, not reviewed) · dsig (significant, not reviewed) · reviewed (diffs, reviewed)
// significant = a diff at or above its threshold (Settings; a threshold not set never counts).
const num = (v) => (v === null || v === undefined ? null : Number(v));
const nz = (v) => v !== null && v !== undefined && v !== 0;
function drawerKey(n) { const m = /^(\d+)$/.exec(n); return m ? [0, Number(m[1]), n] : [1, 0, n]; }
function shapeDrawer(x) {
  const opening = num(x.opening_cents) || 0;
  const expectedClose = num(x.expected_close_cents);
  const ending = num(x.ending_cents);
  const expected = expectedClose === null ? null : expectedClose - opening;
  const storeCounted = ending === null ? null : ending - opening;
  return {
    id: x.drawer_id,
    name: x.drawer_name,
    opening,
    expected,
    storeCounted,
    diff1: expected === null || storeCounted === null ? null : storeCounted - expected,
    removed: num(x.removed_cents) || 0,
  };
}
function sortDrawers(list) {
  return list.sort((a, b) => {
    const ka = drawerKey(String(a.name)); const kb = drawerKey(String(b.name));
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
  });
}
function shapeRow(r, drawers = [], thresholds = {}) {
  const expected = num(r.pos_expected_cents);
  const storeCounted = Number(r.expected_cents || 0);
  const removed = Number(r.removed_cents || 0);
  const counted = num(r.counted_cents);
  const receipted = num(r.receipted_cents);
  const diff1 = expected === null ? null : storeCounted - expected;
  const diff2 = counted === null ? null : counted - storeCounted;
  const diff3 = receipted === null ? null : receipted - removed;
  const deposited = r.deposit_id !== null && r.deposit_id !== undefined;
  const collected = counted !== null;
  const status = deposited ? 'deposited' : (collected ? 'collected' : 'pending');
  const diffs = nz(diff1) || nz(diff2) || nz(diff3) || drawers.some(d => nz(d.diff1));
  const over = (v, t) => nz(v) && t !== null && t !== undefined && Math.abs(v) >= t;
  const significant = over(diff1, thresholds.diff1) || drawers.some(d => over(d.diff1, thresholds.diff1))
    || over(diff2, thresholds.diff2) || over(diff3, thresholds.diff3);
  const reviewed = !!r.reviewed_at;
  return {
    location: r.location,
    date: r.d,
    expected,
    storeCounted,
    counted,
    removed,
    receipted,
    diff1,
    diff2,
    diff3,
    drawers,
    note: r.note || '',
    depositId: deposited ? Number(r.deposit_id) : null,
    depositedAt: r.deposited_at || null,
    deposit: r.deposit_title || null,
    status,
    significant,
    reviewed,
    reviewedAt: r.reviewed_at || null,
    flags: {
      pending: status === 'pending',
      collected: status === 'collected',
      diffs,
      deposited,
      notdeposited: !deposited,
      dall: diffs && !reviewed,
      dsig: diffs && significant && !reviewed,
      reviewed: diffs && reviewed,
    },
  };
}

// Significant discrepancy thresholds (cents; null = not set).
async function readThresholds(db = pool) {
  const r = await db.query(`SELECT value FROM app_settings WHERE key = 'cash_thresholds'`);
  const v = (r.rows[0] && r.rows[0].value) || {};
  const one = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  return { diff1: one(v.diff1), diff2: one(v.diff2), diff3: one(v.diff3) };
}

// Drawer lines of the given location / day pairs → Map 'LOC|YYYY-MM-DD' → [drawer].
async function loadDrawers(locations, from, to, db = pool) {
  const by = new Map();
  if (!locations.length) return by;
  const d = await db.query(
    `SELECT location, to_char(pay_date, 'YYYY-MM-DD') AS d, drawer_id, drawer_name, opening_cents, ending_cents,
            removed_cents, expected_close_cents
       FROM cash_drawer_days WHERE location = ANY($1::text[]) AND pay_date BETWEEN $2::date AND $3::date`,
    [locations, from, to]
  );
  for (const x of d.rows) {
    const k = `${x.location}|${x.d}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(shapeDrawer(x));
  }
  for (const list of by.values()) sortDrawers(list);
  return by;
}

// DB rows → shaped rows with their drawers.
async function shapeRows(dbRows, db = pool) {
  if (!dbRows.length) return [];
  const thresholds = await readThresholds(db);
  const locs = Array.from(new Set(dbRows.map(x => x.location)));
  const days = dbRows.map(x => x.d).sort();
  const drawers = await loadDrawers(locs, days[0], days[days.length - 1], db);
  return dbRows.map(x => shapeRow(x, drawers.get(`${x.location}|${x.d}`) || [], thresholds));
}

// Deposit title: base + "-A", "-B"… when the base is used more than once in a year.
const depositTitle = (d) => (d.suffix ? `${d.title_base}-${d.suffix}` : d.title_base);
const ROW_SELECT = `SELECT p.location, to_char(p.pay_date, 'YYYY-MM-DD') AS d, p.expected_cents, p.removed_cents,
         p.counted_cents, p.receipted_cents, p.note, p.deposit_id, p.pos_expected_cents, p.reviewed_at,
         d.created_at AS deposited_at, CASE WHEN d.id IS NULL THEN NULL
           WHEN d.suffix IS NULL THEN d.title_base ELSE d.title_base || '-' || d.suffix END AS deposit_title
    FROM cash_payments p LEFT JOIN cash_deposits d ON d.id = p.deposit_id`;

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
      adminPinSet: !!(await readAdminPin()),
      thresholds: await readThresholds(), // Significant discrepancy (2026-11-27)
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

// ─── Admin password (2026-11-20, Hera) ───────────────────────────────────────
// Choosing "Admin" asks for it; custom groups don't. Not set yet → Admin opens
// without one (so the first admin can set it in Settings). Changing it makes
// every account that chose Admin choose again. Stored as a scrypt hash.
async function readAdminPin() {
  const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'cash_admin_pin'`);
  const v = r.rows[0] ? r.rows[0].value : null;
  return v && v.hash && v.salt ? v : null;
}
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
async function adminPinOk(pin) {
  const v = await readAdminPin();
  if (!v) return true;
  const a = Buffer.from(hashPin(pin || '', v.salt), 'hex');
  const b = Buffer.from(v.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.put('/admin-pin', async (req, res) => {
  try {
    const pin = String((req.body && req.body.pin) || '');
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'The password must be 4 to 8 digits.' });
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('cash_admin_pin', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ salt, hash: hashPin(pin, salt) })]
    );
    // Everyone in Admin enters the new password next time.
    await pool.query(`DELETE FROM cash_account_groups WHERE group_id = $1`, [ADMIN_ID]);
    res.json({ adminPinSet: true });
  } catch (e) {
    console.error('PUT /api/cash-payments/admin-pin error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /admin-pin/check { pin } → { ok } (the page checks before saving Admin locally)
router.post('/admin-pin/check', async (req, res) => {
  try {
    res.json({ ok: await adminPinOk(req.body && req.body.pin) });
  } catch (e) {
    console.error('POST /api/cash-payments/admin-pin/check error:', e);
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
    if (gid === ADMIN_ID && !(await adminPinOk(req.body && req.body.pin))) {
      return res.status(403).json({ error: 'Incorrect password.', wrongPin: true });
    }
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

// 2026-11-27: mismatch → diffs; Audit › Discrepancy uses dall / dsig / reviewed.
const FILTERS = ['all', 'collected', 'pending', 'diffs', 'deposited', 'notdeposited', 'dall', 'dsig', 'reviewed'];
const EMPTY_COUNTS = { all: 0, collected: 0, pending: 0, diffs: 0, deposited: 0, notdeposited: 0, dall: 0, dsig: 0, reviewed: 0 };

router.get('/rows', async (req, res) => {
  try {
    const rangeCtx = await rangeContext();
    const { start, today, yesterday } = rangeCtx;
    const empty = { counts: { ...EMPTY_COUNTS }, rows: [], total: 0, page: 1, pages: 1 };
    if (!start) return res.json({ ...empty, noStartingDate: true, today, yesterday });
    const locations = String(req.query.locations || '').split(',').map(s => s.trim()).filter(Boolean);
    const range = clampRange(req.query.from, req.query.to, start, yesterday);
    if (!locations.length || !range) return res.json({ ...empty, startingDate: start, today, yesterday, range });

    const r = await pool.query(
      `${ROW_SELECT} WHERE p.location = ANY($1::text[]) AND p.pay_date BETWEEN $2::date AND $3::date`,
      [locations, range.from, range.to]
    );
    const all = await shapeRows(r.rows);
    const counts = { ...EMPTY_COUNTS };
    for (const x of all) {
      counts.all += 1;
      for (const k of Object.keys(x.flags)) if (x.flags[k]) counts[k] += 1;
    }
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
    let list = filter === 'all' ? all : all.filter(x => x.flags[filter]);

    // Location (MTL, OTT, QC, EDM, CAL; numbers ascending), then date —
    // sort=asc oldest first (Collect), otherwise newest first (Audit).
    const asc = req.query.sort === 'asc';
    list.sort((a, b) => compareLocations(a.location, b.location)
      || (asc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));

    const pageSize = Math.max(0, parseInt(req.query.pageSize, 10) || 0); // 0 = everything
    const total = list.length;
    const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    if (pageSize) list = list.slice((page - 1) * pageSize, page * pageSize);

    // Every row carries its drawers (2026-11-27; was ?drawers=1, Audit only).

    res.json({ counts, rows: list, total, page, pages, startingDate: start, today, yesterday, range, fetching: CP.isSyncRunning(), testMode: rangeCtx.test.on });
  } catch (e) {
    console.error('GET /api/cash-payments/rows error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function loadRow(location, date, db = pool) {
  const r = await db.query(`${ROW_SELECT} WHERE p.location = $1 AND p.pay_date = $2::date`, [location, date]);
  return r.rows[0] || null;
}

// Counted / Receipted removed. Only the fields sent are changed; '' / null clears one.
router.put('/row', async (req, res) => {
  try {
    const { location, date } = req.body || {};
    if (!location || !CP.isIsoDate(date)) return res.status(400).json({ error: 'Missing location or date.' });
    const row = await loadRow(location, date);
    if (!row) return res.status(404).json({ error: 'This day has no drawer data yet.' });
    if (row.deposit_id !== null && row.deposit_id !== undefined) return res.status(409).json({ error: 'This day is deposited and can’t be changed.' });
    const sets = [];
    const params = [location, date];
    try {
      if (Object.prototype.hasOwnProperty.call(req.body, 'counted')) {
        params.push(parseAmount(req.body.counted));
        sets.push(`counted_cents = $${params.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'receipted')) {
        params.push(parseAmount(req.body.receipted));
        sets.push(`receipted_cents = $${params.length}`);
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (sets.length) {
      await pool.query(
        // A changed amount needs a new review (2026-11-27).
        `UPDATE cash_payments SET ${sets.join(', ')}, reviewed_at = NULL, updated_at = NOW()
          WHERE location = $1 AND pay_date = $2::date AND deposit_id IS NULL`,
        params
      );
    }
    res.json({ row: (await shapeRows([await loadRow(location, date)]))[0] });
  } catch (e) {
    console.error('PUT /api/cash-payments/row error:', e);
    res.status(500).json({ error: e.message });
  }
});

// One note per row; can be added / edited / deleted any time (also deposited rows).
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
    res.json({ row: (await shapeRows([await loadRow(location, date)]))[0] });
  } catch (e) {
    console.error('PUT /api/cash-payments/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── deposits (2026-11-20, Hera) ─────────────────────────────────────────────

// createDeposit(): services/cashPayments.js (also used by Test Mode).
const { createDeposit } = CP;

// Make Deposit: the chosen days of one location → one deposit; they lock.
// Refused when a day is Pending, already deposited, or not found.
router.post('/deposits', async (req, res) => {
  const { location } = req.body || {};
  const dates = Array.from(new Set((Array.isArray(req.body && req.body.dates) ? req.body.dates : []).filter(CP.isIsoDate)));
  const note = String((req.body && req.body.note) || '').trim();
  if (!location) return res.status(400).json({ error: 'Choose a location.' });
  if (!dates.length) return res.status(400).json({ error: 'Select at least one day.' });
  if (note.length > NOTE_MAX) return res.status(400).json({ error: `Note is too long (max ${NOTE_MAX}).` });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT pay_date, to_char(pay_date, 'YYYY-MM-DD') AS d, expected_cents, removed_cents, counted_cents, deposit_id, is_test
         FROM cash_payments WHERE location = $1 AND to_char(pay_date, 'YYYY-MM-DD') = ANY($2::text[]) FOR UPDATE`,
      [location, dates]
    );
    if (r.rows.length !== dates.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Some days were not found.' }); }
    const bad = r.rows.filter(x => x.deposit_id !== null);
    if (bad.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Already deposited: ${bad.map(x => x.d).join(', ')}.` }); }
    // 2026-11-27: every day needs Counted (No cash days are no longer special).
    const pending = r.rows.filter(x => x.counted_cents === null);
    if (pending.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Pending days can’t be deposited: ${pending.map(x => x.d).join(', ')}.` }); }
    const dep = await createDeposit(client, location, note, { isTest: r.rows.every(x => x.is_test) });
    await client.query(
      `UPDATE cash_payments SET deposit_id = $3, updated_at = NOW() WHERE location = $1 AND to_char(pay_date, 'YYYY-MM-DD') = ANY($2::text[])`,
      [location, dates, dep.id]
    );
    await client.query('COMMIT');
    res.json({ deposit: { id: dep.id, title: depositTitle(dep), days: dates.length } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/cash-payments/deposits error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Deposits of the given locations that hold at least one day in from..to,
// newest first, with their totals.
router.get('/deposits', async (req, res) => {
  try {
    const { start, yesterday } = await rangeContext();
    const locations = String(req.query.locations || '').split(',').map(s => s.trim()).filter(Boolean);
    const range = start ? clampRange(req.query.from, req.query.to, start, yesterday) : null;
    if (!locations.length || !range) return res.json({ deposits: [] });
    const r = await pool.query(
      `SELECT d.id, d.location, d.title_base, d.suffix, d.note, d.created_at,
              COUNT(p.pay_date)::int AS days,
              COALESCE(SUM(p.expected_cents), 0)::bigint AS expected,
              COALESCE(SUM(p.counted_cents), 0)::bigint AS counted,
              COALESCE(SUM(p.removed_cents), 0)::bigint AS removed,
              COALESCE(SUM(CASE WHEN p.receipted_cents IS NULL THEN 0 ELSE p.receipted_cents - p.removed_cents END), 0)::bigint AS removed_diff,
              COALESCE(SUM(p.receipted_cents), 0)::bigint AS receipted,
              COUNT(p.receipted_cents)::int AS receipted_days,
              COALESCE(SUM(p.pos_expected_cents), 0)::bigint AS pos_expected,
              COUNT(p.pos_expected_cents)::int AS pos_expected_days
         FROM cash_deposits d JOIN cash_payments p ON p.deposit_id = d.id
        WHERE d.location = ANY($1::text[])
          AND d.id IN (SELECT deposit_id FROM cash_payments
                        WHERE deposit_id IS NOT NULL AND location = ANY($1::text[]) AND pay_date BETWEEN $2::date AND $3::date)
        GROUP BY d.id, d.location, d.title_base, d.suffix, d.note, d.created_at
        ORDER BY d.created_at DESC, d.id DESC`,
      [locations, range.from, range.to]
    );
    // The days of each deposit (for the title tooltip), oldest first.
    const ids = r.rows.map(d => d.id);
    const daysOf = new Map();
    if (ids.length) {
      const dd = await pool.query(
        `SELECT deposit_id, to_char(pay_date, 'YYYY-MM-DD') AS d FROM cash_payments
          WHERE deposit_id = ANY($1::int[]) ORDER BY pay_date`,
        [ids]
      );
      for (const x of dd.rows) {
        if (!daysOf.has(x.deposit_id)) daysOf.set(x.deposit_id, []);
        daysOf.get(x.deposit_id).push(x.d);
      }
    }
    res.json({
      deposits: r.rows.map(d => ({
        id: d.id,
        title: depositTitle(d),
        location: d.location,
        createdAt: d.created_at,
        days: d.days,
        dates: daysOf.get(d.id) || [],
        expected: Number(d.expected), // Σ StoreCounted (old name)
        storeCounted: Number(d.expected),
        // Σ Expected (expectedCashAtClose − open); null when no day has it (2026-11-27)
        posExpected: d.pos_expected_days ? Number(d.pos_expected) : null,
        counted: Number(d.counted),
        // Discrepancy pill: Σ Counted − Σ StoreCounted of the whole deposit (2026-11-27)
        discrepancy: Number(d.counted) - Number(d.expected),
        removed: Number(d.removed),
        removedDiff: Number(d.removed_diff),
        // Σ Receipted removed entered (null when no day has one) — 2026-11-20
        receipted: d.receipted_days ? Number(d.receipted) : null,
        note: d.note || '',
      })),
    });
  } catch (e) {
    console.error('GET /api/cash-payments/deposits error:', e);
    res.status(500).json({ error: e.message });
  }
});

// The days of one deposit, oldest first, with their drawers (2026-11-27 —
// Audit › Deposits, a card opened).
router.get('/deposits/:id/rows', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await pool.query(`${ROW_SELECT} WHERE p.deposit_id = $1 ORDER BY p.pay_date`, [id]);
    res.json({ rows: await shapeRows(r.rows) });
  } catch (e) {
    console.error('GET /api/cash-payments/deposits/:id/rows error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Audit › Discrepancy › Mark as reviewed (2026-11-27). reviewed false = undo.
router.post('/review', async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const on = !(req.body && req.body.reviewed === false);
    const clean = items.filter(x => x && x.location && CP.isIsoDate(x.date));
    if (!clean.length) return res.status(400).json({ error: 'Select at least one day.' });
    let n = 0;
    for (const x of clean) {
      const u = await pool.query(
        `UPDATE cash_payments SET reviewed_at = ${on ? 'NOW()' : 'NULL'} WHERE location = $1 AND pay_date = $2::date`,
        [x.location, x.date]
      );
      n += u.rowCount;
    }
    res.json({ updated: n });
  } catch (e) {
    console.error('POST /api/cash-payments/review error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Significant discrepancy thresholds (2026-11-27). Amount strings, '' = not set.
router.get('/thresholds', async (req, res) => {
  try { res.json(await readThresholds()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/thresholds', async (req, res) => {
  try {
    const out = {};
    for (const k of ['diff1', 'diff2', 'diff3']) {
      try { out[k] = parseAmount(req.body ? req.body[k] : null); } catch (e) { return res.status(400).json({ error: e.message }); }
    }
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('cash_thresholds', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(out)]
    );
    res.json(out);
  } catch (e) {
    console.error('PUT /api/cash-payments/thresholds error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/deposits/:id/note', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const note = String((req.body && req.body.note) || '').trim();
    if (note.length > NOTE_MAX) return res.status(400).json({ error: `Note is too long (max ${NOTE_MAX}).` });
    const r = await pool.query(`UPDATE cash_deposits SET note = $2 WHERE id = $1`, [id, note || null]);
    if (!r.rowCount) return res.status(404).json({ error: 'Deposit not found.' });
    res.json({ id, note });
  } catch (e) {
    console.error('PUT /api/cash-payments/deposits/:id/note error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.compareLocations = compareLocations;
module.exports.parseAmount = parseAmount;
module.exports.shapeRow = shapeRow;
