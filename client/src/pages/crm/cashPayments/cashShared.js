import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Popover, DatePicker, Box, BlockStack, InlineStack, Text } from '@shopify/polaris';
import { fetchWithAccount } from '../../../accountMemory';

// Operation › Cash Payments — shared bits (2026-11-19, Hera —
// claude/CASH_PAYMENTS_SPEC.md): API calls, money / date formatting, the
// location order, the user-group state, and small controls (location select,
// filter pills, date range calendar) styled like the existing Hub filters.

export async function api(method, url, body) {
  const r = await fetch(`/api/cash-payments${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong'); e.status = r.status; e.data = d; throw e; }
  return d;
}

export const SUBDUED = '#616161';
export const HUB_BOX = { background: '#fff', borderRadius: 12, boxShadow: '0 1px 0 rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08)' };
export const GREEN = '#0c7a43';
export const RED = '#c70a24';

// ── money (cents) ───────────────────────────────────────────────────────────
// 999999 → '9999.99' (no thousands separator, like the envelopes).
export function fmtMoney(cents) {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
// Differences: '+0.86' / '-0.86'; 0 or missing → '' (shown empty).
export function fmtDiff(cents) {
  if (cents === null || cents === undefined || cents === 0) return '';
  return `${cents > 0 ? '+' : ''}${fmtMoney(cents)}`;
}
// Input text → cents | null (empty). undefined = not a valid amount.
export function parseMoney(text) {
  const s = String(text || '').replace(/[,\s$]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

// ── dates ('YYYY-MM-DD', Toronto days from the server) ──────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dateParts(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return { year: y, main: `${MONTHS[m - 1]}.${String(d).padStart(2, '0')}`, dow: DOW[dow] };
}
// 'Nov.01' (+ ', 2025' when not this year) — for buttons / ranges.
export function shortDate(iso, currentYear) {
  const p = dateParts(iso);
  return p.year === currentYear ? p.main : `${p.main}, ${p.year}`;
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function maxIso(a, b) { return a > b ? a : b; }
const toLocalDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const toIso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

// "Last N days" = the N days ending yesterday, not before the Starting date.
export function lastDays(n, settings) {
  const to = settings.yesterday;
  const from = maxIso(addDays(to, -(n - 1)), settings.rangeStart || to);
  return { from, to };
}

// Collect / Audit can show something once the first allowed day (the Starting
// date, or the first fake day in Preview & Test Mode) is yesterday or earlier.
export function isRangeReady(settings) {
  return !!settings.rangeStart && settings.rangeStart <= settings.yesterday;
}
export function notReadyText(settings) {
  if (settings.test && settings.test.on) return 'Preview & Test Mode is on. Click Populate Data in the Settings tab to fill in test data.';
  if (settings.startingDate && settings.startingDate > settings.yesterday) {
    return `Days will appear from ${settings.startingDate} on (each day the morning after). To try the tool before that, turn on Preview & Test Mode in Settings.`;
  }
  return 'Set a Starting date in the Settings tab first. Nothing is fetched or shown before that.';
}

// ── location order: MTL, OTT, QC, EDM, CAL, then others A→Z; numbers ascending
const PREFIX_ORDER = ['MTL', 'OTT', 'QC', 'EDM', 'CAL'];
function locKey(name) {
  const m = /^([A-Za-z]+)(\d*)$/.exec(String(name || ''));
  const prefix = m ? m[1].toUpperCase() : String(name || '');
  const idx = PREFIX_ORDER.indexOf(prefix);
  return { rank: idx === -1 ? PREFIX_ORDER.length : idx, prefix, num: m && m[2] ? parseInt(m[2], 10) : 0 };
}
export function compareLocations(a, b) {
  const ka = locKey(a); const kb = locKey(b);
  if (ka.rank !== kb.rank) return ka.rank - kb.rank;
  if (ka.prefix !== kb.prefix) return ka.prefix < kb.prefix ? -1 : 1;
  if (ka.num !== kb.num) return ka.num - kb.num;
  return String(a).localeCompare(String(b));
}

// ── user group (per Shopify account, localStorage fallback — same pattern as
// Warehouse, pages/warehouse/whAccess.js). groupId 0 = Admin (every location).
export const ADMIN_ID = 0;
const LS_GROUP = 'cash_user_group';
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
function lsRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
async function getJson(url, options) {
  try {
    const r = await fetchWithAccount(url, options);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// → groupId (0 = Admin, n = a group) or null = must choose.
export async function loadMyGroupId(groups) {
  const my = await getJson('/api/cash-payments/groups/my');
  let gid = null;
  if (my && my.identified) gid = my.groupId;
  else {
    const raw = lsGet(LS_GROUP);
    gid = raw === null || raw === '' ? null : parseInt(raw, 10);
    if (Number.isNaN(gid)) gid = null;
  }
  const valid = gid === ADMIN_ID || (gid !== null && groups.some(g => Number(g.id) === gid));
  if (valid) lsSet(LS_GROUP, String(gid)); else { lsRemove(LS_GROUP); gid = null; }
  return gid;
}
export async function chooseMyGroup(gid) {
  lsSet(LS_GROUP, String(gid));
  await getJson('/api/cash-payments/groups/my', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }),
  });
}
export async function forgetMyGroup() {
  lsRemove(LS_GROUP);
  await getJson('/api/cash-payments/groups/my', { method: 'DELETE' });
}

// Filters are kept while moving between tabs, and reset on each new visit.
let visit = {};
export function currentVisit() { return visit; }
export function newVisit() { visit = {}; }

// ── controls ────────────────────────────────────────────────────────────────

const LABEL_STYLE = { fontSize: '13px', color: '#6d7175', marginBottom: '4px', lineHeight: '1.4', fontWeight: '400' };
// Same box as MultiSelectDropdown / DateRangeFilter, so filter rows line up.
const FIELD_BTN = {
  width: '100%', padding: '0 28px 0 10px', border: '1px solid #c9cccf', borderRadius: '8px',
  background: 'white', cursor: 'pointer', textAlign: 'left', fontSize: '14px', position: 'relative',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', height: '36px', lineHeight: '36px',
  boxSizing: 'border-box', color: '#303030', font: 'inherit',
};
const CARET = <span style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>▾</span>;

// Single-choice dropdown with the MultiSelectDropdown look.
// options: [{ value, label }]; value null → placeholder (grey).
export function SingleSelect({ label, options, value, onChange, placeholder = 'Choose', minWidth = 160 }) {
  const [open, setOpen] = useState(false);
  const [dropStyle, setDropStyle] = useState({});
  const btnRef = useRef(null);
  const dropRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current && !btnRef.current.contains(e.target) && dropRef.current && !dropRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropStyle({
        position: 'fixed', top: r.bottom + 4, left: r.left, minWidth: Math.max(r.width, 160), zIndex: 99999,
        background: 'white', border: '1px solid #c9cccf', borderRadius: '8px', maxHeight: '320px', overflowY: 'auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      });
    }
    setOpen(!open);
  };
  const current = options.find(o => o.value === value);
  return (
    <div style={{ position: 'relative', minWidth }}>
      {label && <div style={LABEL_STYLE}>{label}</div>}
      <button ref={btnRef} type="button" onClick={toggle} style={{ ...FIELD_BTN, color: current ? '#303030' : '#8a8a8a' }}>
        {current ? current.label : placeholder}{CARET}
      </button>
      {open && ReactDOM.createPortal(
        <div ref={dropRef} style={dropStyle}>
          {options.length === 0 && <div style={{ padding: '10px 12px', fontSize: 14, color: SUBDUED }}>No options</div>}
          {options.map(o => (
            <div key={o.value} onClick={() => { setOpen(false); onChange(o.value); }}
              style={{
                padding: '10px 12px', cursor: 'pointer', fontSize: 14, borderBottom: '1px solid #f6f6f7',
                background: o.value === value ? '#f1f8f5' : 'white', fontWeight: o.value === value ? 600 : 400,
              }}>
              {o.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// Calendar for a From → To range (same steps as components/DateRangeFilter:
// first click = From, second = To; an earlier second click becomes the new
// From). Only days between min and max can be picked.
export function RangeCalendar({ value, min, max, currentYear, onPick, onClose }) {
  const base = toLocalDate((value && value.from) || max);
  const [view, setView] = useState({ month: base.getMonth(), year: base.getFullYear() });
  const [draftFrom, setDraftFrom] = useState(null);
  const sameDay = (a, b) => toIso(a) === toIso(b);
  const handleChange = (range) => {
    if (!draftFrom) { setDraftFrom(range.start); return; }
    const clicked = sameDay(range.start, draftFrom) ? range.end : range.start;
    if (clicked < draftFrom && !sameDay(clicked, draftFrom)) { setDraftFrom(clicked); return; }
    onPick({ from: toIso(draftFrom), to: toIso(clicked) });
    onClose();
  };
  const maxDate = toLocalDate(max); maxDate.setHours(23, 59, 59, 999);
  return (
    <Box padding="400" minWidth="300px">
      <BlockStack gap="300">
        <Text variant="headingSm" as="p">{draftFrom ? 'Select To date' : 'Select From date'}</Text>
        <Text tone="subdued" variant="bodySm" as="p">
          {draftFrom ? `From: ${shortDate(toIso(draftFrom), currentYear)}` : `Available: ${shortDate(min, currentYear)} – ${shortDate(max, currentYear)}`}
        </Text>
        <DatePicker
          month={view.month}
          year={view.year}
          onMonthChange={(month, year) => setView({ month, year })}
          onChange={handleChange}
          selected={draftFrom ? { start: draftFrom, end: draftFrom } : undefined}
          allowRange
          disableDatesBefore={toLocalDate(min)}
          disableDatesAfter={maxDate}
        />
      </BlockStack>
    </Box>
  );
}

// Collect › Date range: dropdown Last 7 days / Last 30 days / Choose range;
// Choose range opens the calendar. value: { preset: 7 | 30 | 'custom', from, to }.
export function CollectDateRange({ settings, value, onChange }) {
  const [menu, setMenu] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const year = Number(settings.today.slice(0, 4));
  const text = value.preset === 'custom'
    ? `${shortDate(value.from, year)} – ${shortDate(value.to, year)}`
    : `Last ${value.preset} days`;
  const pick = (preset) => {
    setMenu(false);
    if (preset === 'custom') { setCalendar(true); return; }
    onChange({ preset, ...lastDays(preset, settings) });
  };
  const activator = (
    <button type="button" onClick={() => { if (calendar) setCalendar(false); else setMenu(m => !m); }} style={FIELD_BTN}>
      {text}{CARET}
    </button>
  );
  return (
    <div style={{ position: 'relative', minWidth: 200 }}>
      <div style={LABEL_STYLE}>Date range</div>
      <Popover active={menu || calendar} activator={activator} onClose={() => { setMenu(false); setCalendar(false); }}
        preferredAlignment="left" autofocusTarget="none">
        {menu && (
          <div style={{ minWidth: 200, padding: '4px 0' }}>
            {[{ v: 7, l: 'Last 7 days' }, { v: 30, l: 'Last 30 days' }, { v: 'custom', l: 'Choose range' }].map(o => (
              <div key={o.v} onClick={() => pick(o.v)}
                style={{ padding: '10px 12px', cursor: 'pointer', fontSize: 14, background: value.preset === o.v ? '#f1f8f5' : 'white', fontWeight: value.preset === o.v ? 600 : 400 }}>
                {o.l}
              </div>
            ))}
          </div>
        )}
        {calendar && (
          <RangeCalendar
            value={value.preset === 'custom' ? value : null}
            min={settings.rangeStart}
            max={settings.yesterday}
            currentYear={year}
            onPick={(r) => onChange({ preset: 'custom', ...r })}
            onClose={() => setCalendar(false)}
          />
        )}
      </Popover>
    </div>
  );
}

// Small toggle button (Schedule filter-button look).
export const smallBtnStyle = (active = false) => ({
  font: 'inherit', fontSize: 13, padding: '5px 12px', minHeight: 32, borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${active ? '#303030' : '#c9cccf'}`, background: active ? '#303030' : '#fff', color: active ? '#fff' : '#303030',
  display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
});

export const CalendarIcon = ({ color = 'currentColor' }) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5" aria-hidden="true">
    <rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
  </svg>
);

// Count pills that are also the status filter (one at a time).
export const PILLS = [
  { id: 'all', label: 'All' },
  { id: 'collected', label: 'Collected' },
  { id: 'pending', label: 'Pending' },
  { id: 'mismatch', label: 'Mismatch' },
  { id: 'archived', label: 'Archived' },
];
export function FilterPills({ counts, value, onChange }) {
  return (
    <InlineStack gap="200" wrap blockAlign="center">
      {PILLS.map(p => (
        <button key={p.id} type="button" onClick={() => onChange(p.id)} style={smallBtnStyle(value === p.id)}>
          <span>{p.label}</span>
          <span style={{ fontWeight: 650 }}>{counts ? counts[p.id] || 0 : 0}</span>
        </button>
      ))}
    </InlineStack>
  );
}

// Page n of m  ‹ ›
export function Pager({ page, pages, onChange }) {
  if (pages <= 1) return null;
  const btn = (disabled) => ({ ...smallBtnStyle(false), minWidth: 36, justifyContent: 'center', opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' });
  return (
    <InlineStack gap="200" blockAlign="center">
      <span style={{ fontSize: 13 }}>Page {page} of {pages}</span>
      <button type="button" style={btn(page <= 1)} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">‹</button>
      <button type="button" style={btn(page >= pages)} disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">›</button>
    </InlineStack>
  );
}
