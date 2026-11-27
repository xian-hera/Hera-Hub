import React, { useCallback, useEffect, useState } from 'react';
import { Page, Card, BlockStack, InlineStack, Banner, Text, Popover, Button } from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import { DayList, DepositCard } from './CashDays'; // 2026-11-27 layout
import {
  api, FilterPills, AUDIT_PILLS, Pager, RangeCalendar, CalendarIcon, smallBtnStyle, lastDays, currentVisit, shortDate,
  isRangeReady, notReadyText,
} from './cashShared';

// Cash Payments › Audit (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md;
// Admin only and drawer-based since 2026-11-20).
// Locations of the user's group (default: all), Last 7 days / Last 30 days
// (default) / a chosen range (never past yesterday, never before the
// Starting date).
//   Deposit card: deposits holding at least one day of the range, newest first.
//   Detail list: one row per location / day with each drawer's Ending and
//     Removed. Count pills = status filter. 50 rows a page. Sorted by location
//     (MTL, OTT, QC, EDM, CAL; numbers ascending), then the newest day first.
// Amounts are read-only here; notes (day and deposit) can be edited.
//
// 2026-11-27 (Hera) — two sections under the filters:
//   Discrepancy: the days with any diff ≠ 0 (diff1 Expected ↔ StoreCounted per
//     drawer or total, diff2 StoreCounted ↔ Counted, diff3 Removed ↔ Receipted),
//     as day blocks with the location. Pills All · Significant discrepancy
//     (a diff at or above its Settings threshold) · Reviewed. Tick days →
//     Mark as reviewed (they leave All / Significant; Reviewed can undo).
//   Deposits: one card per deposit (newest first), closed / opened; the header
//     shows the location, when it was made, its days, the Discrepancy pill
//     (Σ Counted − Σ StoreCounted of the whole deposit, only when ≠ 0), Total
//     StoreCounted and Total Counted. Opened: the deposit note and its days.
// (Replaces the 2026-11-20 deposit table + detail list.)

const PAGE_SIZE = 10; // days per page in Discrepancy (2026-11-27, Hera: was 50)

// "Back to top" (2026-11-20, Hera): fixed at the top right of the screen,
// outside the page width; shows once the page has been scrolled down.
// In Hub the page scrolls inside <body> (public/index.html sets body
// overflow-y: scroll on top of Polaris' height: 100%), not the window — so
// window.scrollY stays 0. Listen to scrolls anywhere (capture) and read /
// reset body, <html> and window alike.
const scrolledBy = () => Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0, document.body.scrollTop || 0);
function scrollAllToTop() {
  [window, document.documentElement, document.body].forEach((el) => {
    try { el.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { /* ignore */ }
  });
}
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(scrolledBy() > 300);
    onScroll();
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  if (!show) return null;
  return (
    <div style={{ position: 'fixed', top: 16, right: 24, zIndex: 400 }}>
      <Button onClick={scrollAllToTop}>↑ Back to top</Button>
    </div>
  );
}
let memo = null; // { selected, custom, mode, filter } for the visit

export default function CashAudit({ settings, locations }) {
  if (memo && memo.visit !== currentVisit()) memo = null; // new visit → default filters
  const ready = isRangeReady(settings);
  const year = Number(settings.today.slice(0, 4));
  const [selected, setSelected] = useState(() => (memo ? memo.selected.filter(l => locations.includes(l)) : locations));
  const [mode, setMode] = useState(() => (memo ? memo.mode : 'last30')); // 'last7' | 'last30' | 'custom'
  const [custom, setCustom] = useState(() => (memo ? memo.custom : null)); // { from, to }
  const [filter, setFilter] = useState(() => (memo && ['dall', 'dsig', 'reviewed'].includes(memo.filter) ? memo.filter : 'dall'));
  const [picked, setPicked] = useState(() => new Set()); // days ticked for Mark as reviewed
  const [reviewing, setReviewing] = useState(false);
  const [openDeps, setOpenDeps] = useState(() => new Set()); // opened deposit cards
  const [depRows, setDepRows] = useState({});                // deposit id → its days (loaded when opened)
  const [calendar, setCalendar] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [deposits, setDeposits] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { memo = { visit: currentVisit(), selected, mode, custom, filter }; }, [selected, mode, custom, filter]);
  useEffect(() => { setPage(1); setPicked(new Set()); }, [selected, mode, custom, filter]);

  let range = null;
  if (ready) {
    if (mode === 'custom' && custom) range = custom;
    else range = lastDays(mode === 'last7' ? 7 : 30, settings);
  }

  const load = useCallback(async () => {
    if (!ready || !range) return;
    if (selected.length === 0) { setData({ rows: [], counts: null, page: 1, pages: 1 }); setDeposits([]); return; }
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams({
        locations: selected.join(','), from: range.from, to: range.to, filter, sort: 'desc',
        page: String(page), pageSize: String(PAGE_SIZE),
      });
      const dq = new URLSearchParams({ locations: selected.join(','), from: range.from, to: range.to });
      const [rows, deps] = await Promise.all([api('GET', `/rows?${q}`), api('GET', `/deposits?${dq}`)]);
      setData(rows);
      setDeposits(deps.deposits || []);
      // The newest deposit opens by itself the first time.
      setOpenDeps(cur => (cur.size === 0 && deps.deposits && deps.deposits[0] ? new Set([deps.deposits[0].id]) : cur));
      setDepRows({});
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [ready, range && range.from, range && range.to, selected, filter, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const saveNote = async (row, note) => {
    const d = await api('PUT', '/note', { location: row.location, date: row.date, note });
    const same = (r) => r.location === row.location && r.date === row.date;
    setData(cur => cur && { ...cur, rows: cur.rows.map(r => (same(r) ? d.row : r)) });
    setDepRows(cur => {
      const next = { ...cur };
      Object.keys(next).forEach(k => { next[k] = next[k].map(r => (same(r) ? d.row : r)); });
      return next;
    });
  };

  // Deposit cards: the days are loaded the first time a card opens.
  const loadDepositRows = useCallback(async (id) => {
    try {
      const d = await api('GET', `/deposits/${id}/rows`);
      setDepRows(cur => ({ ...cur, [id]: d.rows || [] }));
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    openDeps.forEach(id => { if (!depRows[id]) loadDepositRows(id); });
  }, [openDeps, depRows, loadDepositRows]);
  const toggleDeposit = (id) => setOpenDeps(cur => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Mark as reviewed (or, on the Reviewed pill, take it back).
  const review = async () => {
    const items = ((data && data.rows) || []).filter(r => picked.has(`${r.location}|${r.date}`)).map(r => ({ location: r.location, date: r.date }));
    if (!items.length) return;
    setReviewing(true); setError('');
    try {
      await api('POST', '/review', { items, reviewed: filter !== 'reviewed' });
      setPicked(new Set());
      await load();
    } catch (e) { setError(e.message); } finally { setReviewing(false); }
  };
  const saveDepositNote = async (dep, note) => {
    await api('PUT', `/deposits/${dep.id}/note`, { note });
    setDeposits(cur => (cur || []).map(x => (x.id === dep.id ? { ...x, note } : x)));
  };

  if (!ready) {
    return (
      <Page>
        <Banner tone="info">{notReadyText(settings)}</Banner>
      </Page>
    );
  }

  const customText = custom
    ? (custom.from === custom.to ? shortDate(custom.from, year) : `${shortDate(custom.from, year)} – ${shortDate(custom.to, year)}`)
    : 'Select date range';
  const rangeBtn = (
    <button type="button" style={smallBtnStyle(mode === 'custom')} onClick={() => setCalendar(c => !c)}>
      <CalendarIcon />{customText}
    </button>
  );

  return (
    <Page>
      <BackToTop />
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        <Card>
          <InlineStack gap="400" wrap blockAlign="end">
            <MultiSelectDropdown
              label="Location"
              options={locations}
              selected={selected}
              onChange={setSelected}
              showSelectAll
              placeholder="No location"
              formatDisplay={(sel, all) => (sel.length === 0 ? 'No location' : (all.length > 0 && all.every(v => sel.includes(v)) ? 'All locations' : sel.join(', ')))}
            />
            <InlineStack gap="200" blockAlign="center">
              <button type="button" style={smallBtnStyle(mode === 'last7')} onClick={() => setMode('last7')}>Last 7 days</button>
              <button type="button" style={smallBtnStyle(mode === 'last30')} onClick={() => setMode('last30')}>Last 30 days</button>
              <Popover active={calendar} activator={rangeBtn} onClose={() => setCalendar(false)} preferredAlignment="left" autofocusTarget="none">
                <RangeCalendar
                  value={custom}
                  min={settings.rangeStart}
                  max={settings.yesterday}
                  currentYear={year}
                  onPick={(r) => { setCustom(r); setMode('custom'); }}
                  onClose={() => setCalendar(false)}
                />
              </Popover>
            </InlineStack>
          </InlineStack>
        </Card>

        {/* Discrepancy (2026-11-27) */}
        <div style={{ padding: '8px 0 0' }}><Text variant="headingMd" as="h2">Discrepancy</Text></div>
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <FilterPills pills={AUDIT_PILLS} counts={data && data.counts} value={filter} onChange={setFilter} />
          <InlineStack gap="300" blockAlign="center">
            {data && <Pager page={data.page} pages={data.pages} onChange={setPage} />}
            <Button variant="primary" onClick={review} loading={reviewing} disabled={picked.size === 0 || reviewing}>
              {filter === 'reviewed' ? 'Mark as not reviewed' : 'Mark as reviewed'}
            </Button>
          </InlineStack>
        </InlineStack>
        <Card padding="0">
          {!data && loading
            ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div>
            : (
              <DayList
                rows={(data && data.rows) || []}
                mode="audit"
                currentYear={year}
                selectable={() => true}
                selected={picked}
                onSelect={setPicked}
                onSaveNote={saveNote}
                emptyText={selected.length === 0 ? 'Choose at least one location.' : (filter === 'reviewed' ? 'No reviewed days in this range.' : 'No discrepancy in this range.')}
              />
            )}
          {data && data.pages > 1 && (
            <div style={{ padding: '8px 16px 16px' }}>
              <InlineStack align="center"><Pager page={data.page} pages={data.pages} onChange={setPage} /></InlineStack>
            </div>
          )}
          <div style={{ height: 8 }} />
        </Card>

        {/* Deposits (2026-11-27) */}
        <div style={{ padding: '8px 0 0' }}><Text variant="headingMd" as="h2">Deposits</Text></div>
        {!deposits && loading && <Text tone="subdued">Loading...</Text>}
        {deposits && deposits.length === 0 && <Card><Text tone="subdued">No deposits in this range.</Text></Card>}
        {(deposits || []).map(d => (
          <DepositCard
            key={d.id}
            deposit={d}
            currentYear={year}
            open={openDeps.has(d.id)}
            onToggle={() => toggleDeposit(d.id)}
            rows={depRows[d.id]}
            loading={openDeps.has(d.id) && !depRows[d.id]}
            onSaveNote={saveNote}
            onSaveDepositNote={saveDepositNote}
          />
        ))}
      </BlockStack>
    </Page>
  );
}
