import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Page, Card, BlockStack, InlineStack, Button, Banner, Text, Modal } from '@shopify/polaris';
import CashTable from './CashTable';
import { api, SingleSelect, CollectDateRange, FilterPills, lastDays, currentVisit, isRangeReady, notReadyText } from './cashShared';

// Cash Payments › Collect (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
// The finance person picks one location and a date range (default Last 7
// days) and types Declared / Counted for each day (one row = one envelope).
// Every box is saved as soon as she leaves it. Save & Archive locks every
// not-archived day of the range; refused while any day is Pending.
// Count pills = status filter (one at a time, default Pending); the numbers
// only depend on location + date range. Rows oldest → newest.

// Kept for the visit so going to Audit and back doesn't reset the filters.
let memo = null; // { location, range, filter }

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
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => { memo = { visit: currentVisit(), location, range, filter }; }, [location, range, filter]);
  useEffect(() => { setSticky(new Set()); }, [location, range, filter]);

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

  const counts = useMemo(() => ({
    all: rows.length,
    collected: rows.filter(r => r.flags.collected).length,
    pending: rows.filter(r => r.flags.pending).length,
    mismatch: rows.filter(r => r.flags.mismatch).length,
    archived: rows.filter(r => r.flags.archived).length,
  }), [rows]);
  const keyOf = (r) => `${r.location}|${r.date}`;
  const shown = filter === 'all' ? rows : rows.filter(r => r.flags[filter] || sticky.has(keyOf(r)));
  const toArchive = rows.filter(r => !r.archived).length;

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

  const archive = async () => {
    setArchiving(true); setError('');
    try {
      const d = await api('POST', '/archive', { location, from: range.from, to: range.to });
      setInfo(`${d.archived} day(s) archived.`);
      setConfirmArchive(false);
      await load();
    } catch (e) {
      setError(e.message);
      setConfirmArchive(false);
    } finally { setArchiving(false); }
  };
  const tryArchive = () => {
    setInfo('');
    if (counts.pending > 0) {
      setError(`${counts.pending} day(s) are still Pending. Enter Declared and Counted for every day before Save & Archive.`);
      return;
    }
    setConfirmArchive(true);
  };

  if (!ready) {
    return (
      <Page>
        <Banner tone="info">{notReadyText(settings)}</Banner>
      </Page>
    );
  }

  return (
    <Page>
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {info && <Banner tone="success" onDismiss={() => setInfo('')}>{info}</Banner>}
        {fetching && <Banner tone="info">System amounts are being fetched from Shopify. Reload in a minute to see every day.</Banner>}

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
                  <Button variant="primary" onClick={tryArchive} disabled={loading || toArchive === 0}>Save &amp; Archive</Button>
                </InlineStack>
              </div>
              {loading && rows.length === 0
                ? <div style={{ padding: 16 }}><Text tone="subdued">Loading...</Text></div>
                : (
                  <CashTable
                    rows={shown}
                    currentYear={Number(settings.today.slice(0, 4))}
                    editable
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
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title="Save & Archive?"
        primaryAction={{ content: 'Save & Archive', onAction: archive, loading: archiving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirmArchive(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text>{`${toArchive} day(s) of ${location || ''} will be archived.`}</Text>
            <Text tone="critical">After archiving, Declared and Counted can no longer be changed. Notes can still be edited.</Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
