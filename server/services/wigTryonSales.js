// Online › Wig Try-on › Sale report (2026-11-23, Hera). Spec: claude/WIG_TRYON_FEATURE_SPEC.md §16.
//
// Did a try-on lead to a purchase? A try-on = a storefront `generation_success`
// event of a logged-in customer (customer C, product P, colour, time t). It is
// CONVERTED when C has an order (any channel: online, POS, other) that contains P
// (any variant), created in [t, t + 7 days], not cancelled, line not fully removed.
//
// Orders come from Shopify: syncCustomers() fetches, for every try-on customer, the
// orders created between her first try-on and 7 days after her last one, and keeps
// them in wig_tryon_orders / wig_tryon_order_lines. A customer whose 7-day window has
// closed and was synced after it closed is not fetched again.
// POS orders are only known when the cashier attached the customer to the sale.
const { pool } = require('../database/init');
const { gql } = require('./shopifyGql');
const { getSetting, setSetting } = require('./productData');
const { codeKey } = require('./swatchMatch');

const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 3600 * 1000;
const STATUS_KEY = 'wig_tryon_sales_sync';
const numId = (gid) => { const m = String(gid || '').match(/(\d+)$/); return m ? m[1] : ''; };
const COLOR_OPT = /^(colou?r|couleur)$/i;

// ─── Sync ───────────────────────────────────────────────────────────────────
const ORDERS_QUERY = `
  query WigTryonOrders($q: String!, $after: String) {
    orders(first: 50, query: $q, after: $after, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt cancelledAt sourceName
        retailLocation { name }
        lineItems(first: 100) {
          nodes {
            id quantity currentQuantity title variantTitle
            product { id title productType }
            variant { selectedOptions { name value } }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

let running = null;

async function syncOneCustomer(c) {
  const from = new Date(c.first_try);
  const until = new Date(Math.min(Date.now(), new Date(c.last_try).getTime() + WINDOW_MS));
  const q = `customer_id:${c.customer_id} AND created_at:>='${from.toISOString()}' AND created_at:<='${until.toISOString()}'`;
  const orders = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const d = await gql(ORDERS_QUERY, { q, after });
    orders.push(...(d.orders.nodes || []));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  let name = c.display_name;
  if (!name) {
    try {
      const d = await gql('query($id: ID!) { customer(id: $id) { displayName } }', { id: `gid://shopify/Customer/${c.customer_id}` });
      name = (d.customer && d.customer.displayName) || null;
    } catch (e) { /* name is optional */ }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replace this customer's orders in the fetched range.
    await client.query('DELETE FROM wig_tryon_orders WHERE customer_id = $1 AND created_at >= $2 AND created_at <= $3',
      [c.customer_id, from, until]);
    for (const o of orders) {
      const oid = numId(o.id);
      const isPos = o.sourceName === 'pos' || !!o.retailLocation;
      await client.query(`
        INSERT INTO wig_tryon_orders (order_id, order_name, customer_id, created_at, cancelled_at, is_pos, source_name, location_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (order_id) DO UPDATE SET order_name = EXCLUDED.order_name, customer_id = EXCLUDED.customer_id,
          created_at = EXCLUDED.created_at, cancelled_at = EXCLUDED.cancelled_at, is_pos = EXCLUDED.is_pos,
          source_name = EXCLUDED.source_name, location_name = EXCLUDED.location_name`,
      [oid, o.name, c.customer_id, o.createdAt, o.cancelledAt, isPos, o.sourceName || null, o.retailLocation ? o.retailLocation.name : null]);
      await client.query('DELETE FROM wig_tryon_order_lines WHERE order_id = $1', [oid]);
      for (const li of (o.lineItems && o.lineItems.nodes) || []) {
        await client.query(`
          INSERT INTO wig_tryon_order_lines (order_id, line_id, product_id, product_title, product_type, variant_title, options, quantity, current_qty, amount)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [oid, numId(li.id), li.product ? numId(li.product.id) : null, li.product ? li.product.title : li.title,
          li.product ? li.product.productType : null, li.variantTitle || null,
          JSON.stringify((li.variant && li.variant.selectedOptions) || []), li.quantity,
          li.currentQuantity == null ? li.quantity : li.currentQuantity,
          li.discountedTotalSet ? Number(li.discountedTotalSet.shopMoney.amount) : null]);
      }
    }
    await client.query(`
      INSERT INTO wig_tryon_customers (customer_id, display_name, synced_from, synced_until, synced_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (customer_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, wig_tryon_customers.display_name),
        synced_from = EXCLUDED.synced_from, synced_until = EXCLUDED.synced_until, synced_at = NOW()`,
    [c.customer_id, name, from, until]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return orders.length;
}

// Customers still needing a fetch: never synced, new try-ons since the last fetch
// (first try earlier than synced_from), or the 7-day window was still open at the
// last fetch.
async function customersToSync(limit) {
  const r = await pool.query(`
    SELECT e.customer_id, e.first_try, e.last_try, c.display_name
    FROM (
      SELECT customer_id, MIN(created_at) AS first_try, MAX(created_at) AS last_try
      FROM wig_tryon_events
      WHERE source = 'storefront' AND event_type = 'generation_success' AND customer_id IS NOT NULL
      GROUP BY customer_id
    ) e
    LEFT JOIN wig_tryon_customers c ON c.customer_id = e.customer_id
    WHERE c.customer_id IS NULL
       OR c.synced_from > e.first_try
       OR c.synced_until < LEAST(NOW(), e.last_try + INTERVAL '${WINDOW_DAYS} days')
    ORDER BY e.last_try DESC
    LIMIT $1`, [limit]);
  return r.rows;
}

// Runs one sync (only one at a time). Returns the status object.
function syncCustomers(reason = 'manual', limit = 500) {
  if (running) return running;
  running = (async () => {
    const status = { running: true, reason, startedAt: new Date().toISOString() };
    await setSetting(STATUS_KEY, status).catch(() => {});
    let done = 0; let orders = 0; const errors = [];
    try {
      const list = await customersToSync(limit);
      for (const c of list) {
        try { orders += await syncOneCustomer(c); done++; } catch (e) { errors.push(`${c.customer_id}: ${e.message}`); }
      }
      const out = { running: false, reason, finishedAt: new Date().toISOString(), customers: done, orders, pendingCustomers: list.length - done, errors: errors.slice(0, 5) };
      await setSetting(STATUS_KEY, out);
      if (done || errors.length) console.log(`[wig-tryon sales] synced ${done} customers, ${orders} orders${errors.length ? `, ${errors.length} errors` : ''}`);
      return out;
    } catch (e) {
      const out = { running: false, reason, finishedAt: new Date().toISOString(), error: e.message };
      await setSetting(STATUS_KEY, out).catch(() => {});
      console.error('[wig-tryon sales] sync failed:', e.message);
      return out;
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncStatus() {
  const s = await getSetting(STATUS_KEY, null);
  return { ...(s || { never: true }), running: !!running };
}

// ─── Report data ────────────────────────────────────────────────────────────
// period: '7' | '30' | '90' | 'all' (days back, by try-on date)
function sinceDate(period) {
  const n = parseInt(period, 10);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() - n * 24 * 3600 * 1000) : null;
}

// The colour of an order line: its Color / Colour / Couleur option, else the variant title.
function lineColor(line) {
  const opts = Array.isArray(line.options) ? line.options : [];
  const o = opts.find(x => COLOR_OPT.test(String(x.name || '').trim()));
  return o ? o.value : (line.variant_title || null);
}
function lineHasColor(line, colorName) {
  if (!colorName) return false;
  const want = codeKey(colorName);
  const opts = Array.isArray(line.options) ? line.options : [];
  return opts.some(o => codeKey(o.value) === want) || codeKey(line.variant_title || '') === want;
}

// Loads try-ons of the period + the stored orders of their customers, and works
// out, for every try-on, the purchase that follows it (if any).
async function loadTries(period) {
  const since = sinceDate(period);
  const ev = await pool.query(`
    SELECT id, customer_id, product_id, product_title, vendor, color_name, created_at
    FROM wig_tryon_events
    WHERE source = 'storefront' AND event_type = 'generation_success'
      ${since ? 'AND created_at >= $1' : ''}
    ORDER BY created_at`, since ? [since] : []);
  const tries = ev.rows;
  const customers = [...new Set(tries.map(t => t.customer_id).filter(Boolean))];
  const linesByCustomer = {};
  const names = {};
  const syncedUntil = {};
  if (customers.length) {
    const lr = await pool.query(`
      SELECT o.order_id, o.order_name, o.customer_id, o.created_at, o.is_pos, o.location_name,
             l.product_id, l.product_title, l.product_type, l.variant_title, l.options, l.current_qty, l.amount
      FROM wig_tryon_orders o JOIN wig_tryon_order_lines l ON l.order_id = o.order_id
      WHERE o.customer_id = ANY($1) AND o.cancelled_at IS NULL AND COALESCE(l.current_qty, 1) > 0
      ORDER BY o.created_at`, [customers]);
    for (const l of lr.rows) (linesByCustomer[l.customer_id] = linesByCustomer[l.customer_id] || []).push(l);
    const cr = await pool.query('SELECT customer_id, display_name, synced_until FROM wig_tryon_customers WHERE customer_id = ANY($1)', [customers]);
    for (const c of cr.rows) { names[c.customer_id] = c.display_name; syncedUntil[c.customer_id] = c.synced_until; }
  }
  const now = Date.now();
  for (const t of tries) {
    const start = new Date(t.created_at).getTime();
    const end = start + WINDOW_MS;
    t.windowOpen = end > now;
    t.purchase = null;
    if (!t.customer_id) continue;
    const lines = (linesByCustomer[t.customer_id] || []).filter(l => {
      const at = new Date(l.created_at).getTime();
      return l.product_id === t.product_id && at >= start && at <= end;
    });
    if (lines.length) {
      const first = lines[0];
      t.purchase = {
        orderId: first.order_id, orderName: first.order_name, at: first.created_at, isPos: first.is_pos,
        location: first.location_name,
        colors: [...new Set(lines.filter(l => l.order_id === first.order_id).map(lineColor).filter(Boolean))],
        sameColor: lines.some(l => lineHasColor(l, t.color_name)),
        amount: lines.filter(l => l.order_id === first.order_id).reduce((s, l) => s + (Number(l.amount) || 0), 0),
        days: (new Date(first.created_at).getTime() - start) / (24 * 3600 * 1000),
      };
    }
    // Not yet fetched for this window -> treat as pending, not as "no purchase".
    if (!t.purchase && !t.windowOpen) {
      const su = syncedUntil[t.customer_id] ? new Date(syncedUntil[t.customer_id]).getTime() : 0;
      if (su < end) t.notSynced = true;
    }
  }
  return { tries, linesByCustomer, names };
}

// Status of a try-on (or a customer × wig group): bought | none | pending | guest
function outcomeOf(t) {
  if (!t.customer_id) return 'guest';
  if (t.purchase) return 'bought';
  if (t.windowOpen || t.notSynced) return 'pending';
  return 'none';
}

async function summary(period) {
  const { tries, linesByCustomer, names } = await loadTries(period);
  const known = tries.filter(t => t.customer_id);
  const pairs = groupPairs(known);
  const decided = pairs.filter(p => p.outcome !== 'pending');
  const bought = pairs.filter(p => p.purchase);
  const pos = bought.filter(p => p.purchase.isPos);
  // Other wigs (not tried) bought within 7 days of any try-on of the customer.
  const otherWigCustomers = new Set();
  for (const c of new Set(known.map(t => t.customer_id))) {
    const ct = known.filter(t => t.customer_id === c);
    const tried = new Set(ct.map(t => t.product_id));
    for (const l of linesByCustomer[c] || []) {
      if (tried.has(l.product_id)) continue;
      if (!/wig|perruque/i.test(l.product_type || '')) continue;
      const at = new Date(l.created_at).getTime();
      if (ct.some(t => at >= new Date(t.created_at).getTime() && at <= new Date(t.created_at).getTime() + WINDOW_MS)) { otherWigCustomers.add(c); break; }
    }
  }
  void names;
  return {
    windowDays: WINDOW_DAYS,
    tries: tries.length,
    guestTries: tries.length - known.length,
    customers: new Set(known.map(t => t.customer_id)).size,
    pairs: pairs.length,
    decidedPairs: decided.length,
    pendingPairs: pairs.length - decided.length,
    boughtPairs: bought.length,
    boughtPos: pos.length,
    boughtNonPos: bought.length - pos.length,
    boughtCustomers: new Set(bought.map(p => p.customerId)).size,
    sameColor: bought.filter(p => p.sameColor).length,
    revenue: bought.reduce((s, p) => s + (p.purchase.amount || 0), 0),
    avgDays: bought.length ? bought.reduce((s, p) => s + p.days, 0) / bought.length : null,
    otherWigCustomers: otherWigCustomers.size,
    sync: await syncStatus(),
  };
}

// Customer × wig groups (one row per customer and product).
function groupPairs(known) {
  const map = new Map();
  for (const t of known) {
    const k = `${t.customer_id}|${t.product_id}`;
    let g = map.get(k);
    if (!g) {
      g = { customerId: t.customer_id, productId: t.product_id, productTitle: t.product_title, vendor: t.vendor, tries: [], colors: {} };
      map.set(k, g);
    }
    g.tries.push(t);
    const cn = t.color_name || '';
    g.colors[cn] = (g.colors[cn] || 0) + 1;
    if (t.product_title) g.productTitle = t.product_title;
  }
  const out = [];
  for (const g of map.values()) {
    g.firstTry = g.tries[0].created_at;
    g.lastTry = g.tries[g.tries.length - 1].created_at;
    // first purchase that follows any of the group's try-ons
    const withP = g.tries.filter(t => t.purchase).sort((a, b) => new Date(a.purchase.at) - new Date(b.purchase.at));
    g.purchase = withP.length ? withP[0].purchase : null;
    if (g.purchase) {
      const triedKeys = new Set(Object.keys(g.colors).filter(Boolean).map(codeKey));
      g.sameColor = g.purchase.colors.some(c => triedKeys.has(codeKey(c)));
      // days from the latest try-on before the order
      const before = g.tries.filter(t => new Date(t.created_at) <= new Date(g.purchase.at));
      const ref = before.length ? before[before.length - 1].created_at : g.firstTry;
      g.days = (new Date(g.purchase.at) - new Date(ref)) / (24 * 3600 * 1000);
      g.outcome = 'bought';
    } else {
      g.outcome = g.tries.some(t => outcomeOf(t) === 'pending') ? 'pending' : 'none';
      g.windowEndsAt = new Date(new Date(g.lastTry).getTime() + WINDOW_MS).toISOString();
    }
    delete g.tries;
    out.push(g);
  }
  return out;
}

// List 1: one row per wig; per tried colour: try-ons + customers who then bought
// the wig (any variant) within 7 days, counting only orders of the chosen channel.
async function byProduct(period, channel, page = 1, pageSize = 30) {
  const { tries } = await loadTries(period);
  const wantPos = channel === 'pos';
  const prods = new Map();
  for (const t of tries) {
    let p = prods.get(t.product_id);
    if (!p) { p = { productId: t.product_id, title: t.product_title, vendor: t.vendor, tries: 0, buyers: new Set(), colors: new Map() }; prods.set(t.product_id, p); }
    if (t.product_title) p.title = t.product_title;
    const cn = t.color_name || '';
    let c = p.colors.get(cn);
    if (!c) { c = { color: cn, tries: 0, buyers: new Set() }; p.colors.set(cn, c); }
    p.tries++; c.tries++;
    if (t.purchase && t.purchase.isPos === wantPos) { p.buyers.add(t.customer_id); c.buyers.add(t.customer_id); }
  }
  const rows = [...prods.values()]
    .map(p => ({
      productId: p.productId, title: p.title, vendor: p.vendor, tries: p.tries, bought: p.buyers.size,
      colors: [...p.colors.values()].sort((a, b) => b.tries - a.tries || a.color.localeCompare(b.color))
        .map(c => ({ color: c.color, tries: c.tries, bought: c.buyers.size })),
    }))
    .sort((a, b) => b.tries - a.tries || b.bought - a.bought || String(a.title).localeCompare(String(b.title)));
  const p = Math.max(1, parseInt(page, 10) || 1);
  return { total: rows.length, page: p, pageSize, rows: rows.slice((p - 1) * pageSize, p * pageSize) };
}

// List 2: one row per customer × wig.
async function byCustomer(period, { outcome, q, page = 1, pageSize = 30 } = {}) {
  const { tries, names } = await loadTries(period);
  let rows = groupPairs(tries.filter(t => t.customer_id)).map(g => ({ ...g, customerName: names[g.customerId] || null }));
  if (outcome === 'same') rows = rows.filter(r => r.purchase && r.sameColor);
  else if (outcome === 'other') rows = rows.filter(r => r.purchase && !r.sameColor);
  else if (outcome === 'bought') rows = rows.filter(r => r.purchase);
  else if (outcome === 'none' || outcome === 'pending') rows = rows.filter(r => r.outcome === outcome);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter(r => [r.customerName, r.customerId, r.productTitle, r.vendor].some(x => String(x || '').toLowerCase().includes(s)));
  }
  rows.sort((a, b) => new Date(b.lastTry) - new Date(a.lastTry));
  const p = Math.max(1, parseInt(page, 10) || 1);
  return {
    total: rows.length, page: p, pageSize,
    rows: rows.slice((p - 1) * pageSize, p * pageSize).map(r => ({
      ...r, colors: Object.entries(r.colors).map(([color, n]) => ({ color, n })),
    })),
  };
}

module.exports = { WINDOW_DAYS, syncCustomers, syncStatus, summary, byProduct, byCustomer };
