// Online › Wig Try-on › Sale report (2026-11-23, Hera). Server: services/wigTryonSales.js.
// Did a try-on lead to a purchase of the same wig (any variant) within 7 days?
// Orders of ALL channels; POS only when the customer was attached to the sale.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, BlockStack, InlineStack, InlineGrid, Text, Select, Button, Badge, Box, TextField } from '@shopify/polaris';
import { api, ADMIN_PRODUCT, ADMIN_CUSTOMER, fmtNum, TH, TD } from './wigTryonApi';

const PERIODS = [
  { label: 'Last 7 days', value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
  { label: 'All time', value: 'all' },
];
const ADMIN_ORDER = 'https://admin.shopify.com/store/beaute-hera/orders/';
const NW = { ...TD, whiteSpace: 'nowrap', wordBreak: 'normal' };
const pctOf = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dateOnly = (iso) => (iso ? new Date(iso).toLocaleDateString() : '');

function Stat({ label, value, sub }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text tone="subdued" variant="bodySm">{label}</Text>
        <Text variant="headingLg" as="p">{value}</Text>
        {sub && <Text tone="subdued" variant="bodySm">{sub}</Text>}
      </BlockStack>
    </Card>
  );
}

function Pager({ page, total, pageSize, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <InlineStack gap="200" align="center" blockAlign="center">
      <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <Text>Page {page} of {pages}</Text>
      <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </InlineStack>
  );
}

// "5 · 2": black = try-ons, pink = customers who bought the wig within 7 days.
function Cell({ tries, bought }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <b style={{ color: '#111' }}>{tries}</b>
      <span style={{ color: '#8a8a8a', margin: '0 4px' }}>·</span>
      <b style={{ color: bought ? '#E32A69' : '#b5b5b5' }}>{bought}</b>
    </span>
  );
}

function ByProduct({ period, setBanner }) {
  const [channel, setChannel] = useState('nonpos');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  useEffect(() => { setPage(1); }, [period, channel]);
  useEffect(() => {
    setData(null);
    api.get(`/sales/products?period=${period}&channel=${channel}&page=${page}`).then(setData).catch(e => setBanner({ tone: 'critical', text: e.message }));
  }, [period, channel, page, setBanner]);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <BlockStack gap="050">
            <Text variant="headingMd">By wig</Text>
            <Text tone="subdued" variant="bodySm">Each cell: <b style={{ color: '#111' }}>try-ons</b> · <b style={{ color: '#E32A69' }}>customers who bought this wig (any variant) within 7 days</b>.</Text>
          </BlockStack>
          <InlineStack gap="100">
            <Button pressed={channel === 'nonpos'} onClick={() => setChannel('nonpos')}>Non-POS purchases</Button>
            <Button pressed={channel === 'pos'} onClick={() => setChannel('pos')}>POS purchases</Button>
          </InlineStack>
        </InlineStack>
        {!data ? <Text tone="subdued">Loading...</Text> : !data.rows.length ? <Text tone="subdued">No try-ons in this period.</Text> : (
          <>
            <Box overflowX="auto">
              <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                <thead>
                  <tr><th style={TH}>Wig</th><th style={TH}>Total</th><th style={TH} colSpan={99}>Colours tried</th></tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.productId}>
                      <td style={{ ...NW, maxWidth: 240 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.title}>
                          <a href={`${ADMIN_PRODUCT}${r.productId}`} target="_blank" rel="noreferrer">{r.title || r.productId}</a>
                        </div>
                        {r.vendor && <div style={{ color: '#6d7175', fontSize: 12 }}>{r.vendor}</div>}
                      </td>
                      <td style={{ ...NW, background: '#f6f6f7' }}><Cell tries={r.tries} bought={r.bought} /></td>
                      {r.colors.map(c => (
                        <td key={c.color} style={NW}>
                          <div style={{ fontSize: 12, color: '#6d7175', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.color || 'No colour'}>{c.color || '(no colour)'}</div>
                          <Cell tries={c.tries} bought={c.bought} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
          </>
        )}
      </BlockStack>
    </Card>
  );
}

const OUTCOMES = [
  { label: 'All', value: '' },
  { label: 'Bought (any colour)', value: 'bought' },
  { label: 'Bought a colour they tried', value: 'same' },
  { label: 'Bought another colour', value: 'other' },
  { label: 'No purchase in 7 days', value: 'none' },
  { label: 'Pending (7 days not over)', value: 'pending' },
];

function Outcome({ r }) {
  if (r.outcome === 'bought') {
    const days = r.days < 1 ? 'same day' : `${Math.round(r.days)} day${Math.round(r.days) === 1 ? '' : 's'} later`;
    return <InlineStack gap="100" wrap={false}><Badge tone="success">Bought</Badge><Text as="span" tone="subdued">{days} · {r.purchase.isPos ? `POS${r.purchase.location ? ` (${r.purchase.location})` : ''}` : 'Non-POS'}</Text></InlineStack>;
  }
  if (r.outcome === 'pending') {
    const left = Math.max(0, Math.ceil((new Date(r.windowEndsAt) - Date.now()) / 86400000));
    return <InlineStack gap="100" wrap={false}><Badge tone="attention">Pending</Badge><Text as="span" tone="subdued">{left ? `${left} day${left === 1 ? '' : 's'} left` : 'waiting for sync'}</Text></InlineStack>;
  }
  return <Badge>No purchase</Badge>;
}

function ByCustomer({ period, setBanner }) {
  const [outcome, setOutcome] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  useEffect(() => { setPage(1); }, [period, outcome, query]);
  useEffect(() => {
    setData(null);
    const p = new URLSearchParams({ period, page: String(page) });
    if (outcome) p.set('outcome', outcome);
    if (query) p.set('q', query);
    api.get(`/sales/customers?${p}`).then(setData).catch(e => setBanner({ tone: 'critical', text: e.message }));
  }, [period, outcome, query, page, setBanner]);

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text variant="headingMd">By customer</Text>
          <Text tone="subdued" variant="bodySm">One row per customer and wig. ✓ = the colour bought is one she tried.</Text>
        </BlockStack>
        <InlineStack gap="300" wrap blockAlign="end">
          <div style={{ minWidth: 240 }}><Select label="Result" options={OUTCOMES} value={outcome} onChange={setOutcome} /></div>
          <div style={{ minWidth: 260 }}>
            <TextField label="Search" value={q} onChange={setQ} autoComplete="off" placeholder="Customer or wig"
              onKeyDown={(e) => { if (e.key === 'Enter') setQuery(q.trim()); }}
              connectedRight={<Button onClick={() => setQuery(q.trim())}>Search</Button>} />
          </div>
        </InlineStack>
        {!data ? <Text tone="subdued">Loading...</Text> : !data.rows.length ? <Text tone="subdued">Nothing to show.</Text> : (
          <>
            <Text tone="subdued" variant="bodySm">{fmtNum(data.total)} rows</Text>
            <Box overflowX="auto">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>Customer</th><th style={TH}>Wig</th><th style={TH}>Colours tried</th><th style={TH}>Last try-on</th>
                    <th style={TH}>Result</th><th style={TH}>Order</th><th style={TH}>Colour bought</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={`${r.customerId}-${r.productId}`}>
                      <td style={{ ...NW, maxWidth: 180 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.customerName || r.customerId}>
                          <a href={`${ADMIN_CUSTOMER}${r.customerId}`} target="_blank" rel="noreferrer">{r.customerName || r.customerId}</a>
                        </div>
                      </td>
                      <td style={{ ...NW, maxWidth: 220 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productTitle}>
                          <a href={`${ADMIN_PRODUCT}${r.productId}`} target="_blank" rel="noreferrer">{r.productTitle || r.productId}</a>
                        </div>
                      </td>
                      <td style={NW}>{r.colors.map(c => `${c.color || '(no colour)'}${c.n > 1 ? ` ×${c.n}` : ''}`).join(', ')}</td>
                      <td style={NW}>{dateOnly(r.lastTry)}</td>
                      <td style={NW}><Outcome r={r} /></td>
                      <td style={NW}>{r.purchase ? <a href={`${ADMIN_ORDER}${r.purchase.orderId}`} target="_blank" rel="noreferrer">{r.purchase.orderName}</a> : '—'}
                        {r.purchase && <div style={{ color: '#6d7175', fontSize: 12 }}>{dateOnly(r.purchase.at)}</div>}</td>
                      <td style={NW}>{r.purchase
                        ? <InlineStack gap="100" wrap={false}><span>{r.purchase.colors.join(', ') || '—'}</span>{r.sameColor ? <Badge tone="success">✓ tried</Badge> : <Badge tone="warning">not tried</Badge>}</InlineStack>
                        : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
          </>
        )}
      </BlockStack>
    </Card>
  );
}

export default function WigTryonSales({ setBanner }) {
  const [period, setPeriod] = useState('30');
  const [sum, setSum] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const timer = useRef(null);

  const loadSummary = useCallback(() => {
    setSum(null);
    api.get(`/sales/summary?period=${period}`).then(setSum).catch(e => setBanner({ tone: 'critical', text: e.message }));
  }, [period, setBanner]);
  useEffect(() => { loadSummary(); }, [loadSummary, reloadKey]);
  useEffect(() => { const t = timer; return () => clearTimeout(t.current); }, []);

  const pollSync = () => {
    timer.current = setTimeout(async () => {
      try {
        const s = await api.get('/sales/sync-status');
        if (s.running) return pollSync();
        setSyncing(false);
        setBanner(s.error ? { tone: 'critical', text: `Sync failed: ${s.error}` } : { tone: 'success', text: `Orders updated (${s.customers || 0} customers checked).` });
        setReloadKey(k => k + 1);
      } catch (e) { setSyncing(false); }
    }, 2500);
  };
  const sync = async () => {
    setSyncing(true);
    try { await api.post('/sales/sync'); pollSync(); } catch (e) { setSyncing(false); setBanner({ tone: 'critical', text: e.message }); }
  };

  const s = sum;
  const last = s && s.sync && (s.sync.finishedAt || s.sync.startedAt);
  return (
    <BlockStack gap="400">
      <InlineStack gap="300" blockAlign="center" wrap>
        <div style={{ minWidth: 180 }}><Select label="Try-ons in" labelInline options={PERIODS} value={period} onChange={setPeriod} /></div>
        <Button onClick={sync} loading={syncing || (s && s.sync && s.sync.running)}>Refresh orders</Button>
        <Text tone="subdued" variant="bodySm">Orders last updated: {last ? new Date(last).toLocaleString() : 'never'} · updates every hour</Text>
      </InlineStack>

      {!s ? <Text tone="subdued">Loading...</Text> : (
        <>
          <InlineGrid columns={{ xs: 2, md: 3, lg: 6 }} gap="300">
            <Stat label="Customers who tried" value={fmtNum(s.customers)} sub={`${fmtNum(s.tries)} try-ons · ${fmtNum(s.pairs)} customer × wig`} />
            <Stat label={`Bought the wig within ${s.windowDays} days`} value={fmtNum(s.boughtPairs)}
              sub={`${pctOf(s.boughtPairs, s.decidedPairs)} of finished · ${fmtNum(s.boughtCustomers)} customers`} />
            <Stat label="POS / Non-POS" value={`${fmtNum(s.boughtPos)} / ${fmtNum(s.boughtNonPos)}`} sub="POS: only when the customer was attached to the sale" />
            <Stat label="Bought a colour they tried" value={fmtNum(s.sameColor)} sub={`${pctOf(s.sameColor, s.boughtPairs)} of purchases`} />
            <Stat label="Sales of tried wigs" value={money(s.revenue)} sub={s.avgDays == null ? 'after discounts' : `avg. ${s.avgDays.toFixed(1)} days after the try-on`} />
            <Stat label="Bought another wig" value={fmtNum(s.otherWigCustomers)} sub="customers who bought a wig they didn't try, within 7 days" />
          </InlineGrid>
          <Text tone="subdued" variant="bodySm">
            Pending (7 days not over yet): {fmtNum(s.pendingPairs)} customer × wig. Rates count finished ones only.
            {s.guestTries ? ` ${fmtNum(s.guestTries)} try-ons without login can't be followed.` : ''}
          </Text>
        </>
      )}

      <ByProduct key={`p${reloadKey}`} period={period} setBanner={setBanner} />
      <ByCustomer key={`c${reloadKey}`} period={period} setBanner={setBanner} />
    </BlockStack>
  );
}
