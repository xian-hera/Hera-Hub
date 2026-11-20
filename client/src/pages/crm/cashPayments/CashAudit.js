import React, { useCallback, useEffect, useState } from 'react';
import { Page, Card, BlockStack, InlineStack, Banner, Text, Popover } from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import { DetailTable, DepositTable } from './CashTable';
import {
  api, FilterPills, Pager, RangeCalendar, CalendarIcon, smallBtnStyle, lastDays, currentVisit, shortDate,
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

const PAGE_SIZE = 50;
let memo = null; // { selected, custom, mode, filter } for the visit

export default function CashAudit({ settings, locations }) {
  if (memo && memo.visit !== currentVisit()) memo = null; // new visit → default filters
  const ready = isRangeReady(settings);
  const year = Number(settings.today.slice(0, 4));
  const [selected, setSelected] = useState(() => (memo ? memo.selected.filter(l => locations.includes(l)) : locations));
  const [mode, setMode] = useState(() => (memo ? memo.mode : 'last30')); // 'last7' | 'last30' | 'custom'
  const [custom, setCustom] = useState(() => (memo ? memo.custom : null)); // { from, to }
  const [filter, setFilter] = useState(() => (memo ? memo.filter : 'all'));
  const [calendar, setCalendar] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [deposits, setDeposits] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { memo = { visit: currentVisit(), selected, mode, custom, filter }; }, [selected, mode, custom, filter]);
  useEffect(() => { setPage(1); }, [selected, mode, custom, filter]);

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
        page: String(page), pageSize: String(PAGE_SIZE), drawers: '1',
      });
      const dq = new URLSearchParams({ locations: selected.join(','), from: range.from, to: range.to });
      const [rows, deps] = await Promise.all([api('GET', `/rows?${q}`), api('GET', `/deposits?${dq}`)]);
      setData(rows);
      setDeposits(deps.deposits || []);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [ready, range && range.from, range && range.to, selected, filter, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const saveNote = async (row, note) => {
    const d = await api('PUT', '/note', { location: row.location, date: row.date, note });
    setData(cur => cur && { ...cur, rows: cur.rows.map(r => (r.location === row.location && r.date === row.date ? { ...d.row, drawers: r.drawers } : r)) });
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

        {/* Deposit card (2026-11-20) */}
        <Card padding="0">
          <BlockStack gap="200">
            <div style={{ padding: '16px 16px 0' }}>
              <Text variant="headingSm" as="h2">Deposits</Text>
            </div>
            {!deposits && loading
              ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div>
              : <DepositTable deposits={deposits || []} onSaveNote={saveDepositNote} emptyText="No deposits in this range." />}
            <div style={{ height: 8 }} />
          </BlockStack>
        </Card>

        {/* Detail list */}
        <Card padding="0">
          <BlockStack gap="200">
            <div style={{ padding: '16px 16px 4px' }}>
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <FilterPills counts={data && data.counts} value={filter} onChange={setFilter} />
                {data && <Pager page={data.page} pages={data.pages} onChange={setPage} />}
              </InlineStack>
            </div>
            {!data && loading
              ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div>
              : (
                <DetailTable
                  rows={(data && data.rows) || []}
                  currentYear={year}
                  onSaveNote={saveNote}
                  emptyText={selected.length === 0 ? 'Choose at least one location.' : 'Nothing in this range.'}
                />
              )}
            {data && data.pages > 1 && (
              <div style={{ padding: '8px 16px 16px' }}>
                <InlineStack align="center"><Pager page={data.page} pages={data.pages} onChange={setPage} /></InlineStack>
              </div>
            )}
            <div style={{ height: 8 }} />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
