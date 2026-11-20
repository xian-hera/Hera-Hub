import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Page, Card, BlockStack, InlineStack, Button, Banner, Text, Modal, TextField } from '@shopify/polaris';
import { CollectTable, canDeposit } from './CashTable';
import { api, SingleSelect, CollectDateRange, FilterPills, lastDays, currentVisit, isRangeReady, notReadyText, dateParts } from './cashShared';

// Cash Payments › Collect (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md;
// drawer-based since 2026-11-20).
// Finance picks one location and a date range (default Last 7 days). Per day:
// Expected / Removed come from the POS drawers; she types Counted and,
// optionally, Receipted removed (saved as soon as she leaves the box).
// Make Deposit: the ticked days become one deposit and lock (Pending days
// can't be ticked). Count pills = status filter (one at a time, default
// Pending); the numbers only depend on location + date range. Oldest → newest.
// (Before 2026-11-20: Declared / Counted vs System, and Save & Archive.)

// Kept for the visit so going to Audit and back doesn't reset the filters.
let memo = null; // { location, range, filter }

const EMPTY_COUNTS = { all: 0, collected: 0, pending: 0, mismatch: 0, deposited: 0, notdeposited: 0 };

export default function CashCollect({ settings, locations }) {
  if (memo && memo.visit !== currentVisit()) memo = null; // new visit → default filters
  const ready = isRangeReady(settings);
  const [location, setLocation] = useState(() => (memo && locations.includes(memo.location) ? memo.location : null));
  const [range, setRange] = useState(() => (memo && memo.range) || (ready ? { preset: 7, ...lastDays(7, settings) } : null));
  const [filter, setFilter] = useState(() => (memo && memo.filter) || 'pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [fetching, setFetching] = useState(false);
  // Rows edited while a filter is on stay visible until the filters change
  // (a row doesn't vanish from under the cursor when it stops being Pending).
  const [sticky, setSticky] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [confirmDeposit, setConfirmDeposit] = useState(false);
  const [depositNote, setDepositNote] = useState('');
  const [depositing, setDepositing] = useState(false);

  useEffect(() => { memo = { visit: currentVisit(), location, range, filter }; }, [location, range, filter]);
  useEffect(() => { setSticky(new Set()); }, [location, range, filter]);
  useEffect(() => { setSelected(new Set()); }, [location, range]);

  const load = useCallback(async () => {
    if (!location || !range) { setRows([]); return; }
    setLoading(true); setError('');
    try {
      const q = new URLSearchParams({ locations: location, from: range.from, to: range.to, filter: 'all', sort: 'asc', pageSize: '0' });
      const d = await api('GET', `/rows?${q}`);
      setRows(d.rows || []);
      setFetching(!!d.fetching);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [location, range]);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { ...EMPTY_COUNTS };
    for (const r of rows) {
      c.all += 1;
      for (const k of Object.keys(r.flags)) if (r.flags[k]) c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [rows]);
  const keyOf = (r) => `${r.location}|${r.date}`;
  const shown = filter === 'all' ? rows : rows.filter(r => r.flags[filter] || sticky.has(keyOf(r)));
  // Ticked days that can still be deposited (a day that became Pending again drops out).
  const toDeposit = rows.filter(r => selected.has(keyOf(r)) && canDeposit(r));

  const replaceRow = (row) => {
    setRows(list => list.map(r => (keyOf(r) === keyOf(row) ? row : r)));
    setSticky(s => { const n = new Set(s); n.add(keyOf(row)); return n; });
  };

  const saveAmount = async (row, field, cents) => {
    try {
      const d = await api('PUT', '/row', { location: row.location, date: row.date, [field]: cents === null ? null : (cents / 100).toFixed(2) });
      replaceRow(d.row);
      return true;
    } catch (e) {
      setError(e.message);
      if (e.status === 409) load();
      return false;
    }
  };
  const saveNote = async (row, note) => {
    const d = await api('PUT', '/note', { location: row.location, date: row.date, note });
    replaceRow(d.row);
  };

  const makeDeposit = async () => {
    setDepositing(true); setError('');
    try {
      const d = await api('POST', '/deposits', { location, dates: toDeposit.map(r => r.date), note: depositNote });
      setInfo(`${d.deposit.title}: ${d.deposit.days} day(s) deposited.`);
      setConfirmDeposit(false);
      setDepositNote('');
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e.message);
      setConfirmDeposit(false);
    } finally { setDepositing(false); }
  };

  if (!ready) {
    return (
      <Page>
        <Banner tone="info">{notReadyText(settings)}</Banner>
      </Page>
    );
  }

  const total = (k) => toDeposit.reduce((a, r) => a + (r[k] || 0), 0);
  const money = (c) => `${c < 0 ? '-' : ''}${(Math.abs(c) / 100).toFixed(2)}`;

  return (
    <Page>
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {info && <Banner tone="success" onDismiss={() => setInfo('')}>{info}</Banner>}
        {fetching && <Banner tone="info">Drawer cash is being fetched from Shopify. Reload in a minute to see every day.</Banner>}

        <Card>
          <InlineStack gap="400" wrap blockAlign="end">
            <SingleSelect
              label="Location"
              placeholder="Choose location"
              options={locations.map(l => ({ value: l, label: l }))}
              value={location}
              onChange={setLocation}
            />
            <CollectDateRange settings={settings} value={range} onChange={setRange} />
          </InlineStack>
        </Card>

        {!location ? (
          <Card><Text tone="subdued">Choose a location to start.</Text></Card>
        ) : (
          <Card padding="0">
            <BlockStack gap="200">
              <div style={{ padding: '16px 16px 4px' }}>
                <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                  <FilterPills counts={counts} value={filter} onChange={setFilter} />
                  <Button variant="primary" onClick={() => setConfirmDeposit(true)} disabled={loading || toDeposit.length === 0}>
                    {toDeposit.length ? `Make Deposit (${toDeposit.length})` : 'Make Deposit'}
                  </Button>
                </InlineStack>
              </div>
              {loading && rows.length === 0
                ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div>
                : (
                  <CollectTable
                    rows={shown}
                    currentYear={Number(settings.today.slice(0, 4))}
                    selected={selected}
                    onSelect={setSelected}
                    onSaveAmount={saveAmount}
                    onSaveNote={saveNote}
                    emptyText={rows.length === 0 ? 'No days in this range yet.' : 'No days with this status.'}
                  />
                )}
              <div style={{ height: 8 }} />
            </BlockStack>
          </Card>
        )}
      </BlockStack>

      <Modal
        open={confirmDeposit}
        onClose={() => setConfirmDeposit(false)}
        title={`Make Deposit — ${location || ''}`}
        primaryAction={{ content: 'Make Deposit', onAction: makeDeposit, loading: depositing }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirmDeposit(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text>
              {`${toDeposit.length} day(s): ${toDeposit.map(r => dateParts(r.date).main).join(', ')}`}
            </Text>
            <Text>{`Counted ${money(total('counted'))} · Expected ${money(total('expected'))} · Removed ${money(total('removed'))}`}</Text>
            <TextField label="Deposit note (optional)" value={depositNote} onChange={setDepositNote} multiline={2} maxLength={1000} autoComplete="off" />
            <Text tone="critical">After the deposit, these days can no longer be changed. Notes can still be edited.</Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
