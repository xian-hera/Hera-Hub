// Cash Payments tables (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
//
//   cash_payments       one row per location per day (= one envelope).
//                       Amounts in cents. system_cents comes from Shopify
//                       (ShopifyQL, cash net payments) — see services/cashPayments.js.
//                       declared = amount written on the envelope, counted =
//                       amount the finance person counted. archived_at set by
//                       Save & Archive → amounts can't change any more.
//   cash_payment_days   days whose System amounts were fetched (a day is
//                       fetched once; after it passes it doesn't change).
//   cash_account_groups the Cash Payments user group each Shopify account
//                       picked (group_id 0 = Admin = every location).
//   app_settings 'cash_user_groups'  [{ id, name, locations: ['MTL01', …] }]
//   app_settings 'cash_starting_date' 'YYYY-MM-DD' (missing = not set → nothing
//                       is fetched or shown).

async function ensureCashPaymentsTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS cash_payments (
      location       TEXT NOT NULL,
      pay_date       DATE NOT NULL,
      system_cents   BIGINT NOT NULL DEFAULT 0,
      declared_cents BIGINT,
      counted_cents  BIGINT,
      note           TEXT,
      archived_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (location, pay_date)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS cash_payments_date_idx ON cash_payments (pay_date)`);
  // System = Shopify's ROUNDED cash net payments (2026-11-20, Hera — Canadian
  // cash is rounded to 5 cents); unrounded_cents keeps the amount before
  // rounding for the "Rounded from …" tooltip. NULL on rows fetched before.
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS unrounded_cents BIGINT`);
  // Preview & Test Mode fake rows (2026-11-19, temporary — services/cashPaymentsTest.js).
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE`);
  // ── Drawer-based structure (2026-11-20, Hera) ─────────────────────────────
  // System / Declared / Archive are no longer used (columns kept, unused).
  //   expected_cents = Σ over the location's drawers of (Ending cash − cash at open)
  //   removed_cents  = Σ cash removed from the drawers that day (positive)
  //   counted_cents  = entered by finance (existing column)
  //   receipted_cents = removed cash backed by receipts (optional)
  //   deposit_id     = the deposit this day belongs to (Make Deposit) → locked
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS expected_cents BIGINT NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS removed_cents BIGINT NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS receipted_cents BIGINT`);
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS deposit_id INTEGER`);
  // One row per location / day / drawer (POS cash drawer, e.g. "71").
  await client.query(`
    CREATE TABLE IF NOT EXISTS cash_drawer_days (
      location      TEXT NOT NULL,
      pay_date      DATE NOT NULL,
      drawer_id     TEXT NOT NULL,
      drawer_name   TEXT NOT NULL,
      opening_cents BIGINT NOT NULL DEFAULT 0,
      ending_cents  BIGINT,
      removed_cents BIGINT NOT NULL DEFAULT 0,
      sessions      INTEGER NOT NULL DEFAULT 1,
      is_test       BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (location, pay_date, drawer_id)
    )
  `);
  // Deposits: days of one location put together by Make Deposit. Title shown =
  // title_base ("MTL01-JAN-05", day of Make Deposit, Toronto) + "-" + suffix
  // when the same base exists more than once in title_year (A, B, C…).
  await client.query(`
    CREATE TABLE IF NOT EXISTS cash_deposits (
      id         SERIAL PRIMARY KEY,
      location   TEXT NOT NULL,
      title_base TEXT NOT NULL,
      title_year INTEGER NOT NULL,
      suffix     TEXT,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_test    BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  // ── Expected vs StoreCounted (2026-11-27, Hera) ────────────────────────────
  // Per drawer, Shopify's expectedCashAtClose (what the system says should be
  // in the drawer) next to the StoreCounted cashCountedAtClose (ending_cents).
  //   cash_drawer_days.expected_close_cents  expectedCashAtClose (float included; NULL = not fetched)
  //   cash_payments.pos_expected_cents       Σ drawers (expectedCashAtClose − cash at open)
  //   cash_payments.expected_cents           keeps its meaning: Σ drawers (cashCountedAtClose − cash at open)
  //                                          — shown as "StoreCounted" from 2026-11-27 on
  //   cash_payments.reviewed_at              Audit › Discrepancy › Mark as reviewed (cleared when
  //                                          Counted / Receipted change)
  // Thresholds for "Significant discrepancy": app_settings 'cash_thresholds'
  // { diff1, diff2, diff3 } in cents (null = not set).
  await client.query(`ALTER TABLE cash_drawer_days ADD COLUMN IF NOT EXISTS expected_close_cents BIGINT`);
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS pos_expected_cents BIGINT`);
  await client.query(`ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS cash_payment_days (
      pay_date   DATE PRIMARY KEY,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS cash_account_groups (
      account_id TEXT PRIMARY KEY,
      group_id   INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ('cash_user_groups', '[]'::jsonb) ON CONFLICT (key) DO NOTHING`
  ).catch(() => {});
}

module.exports = { ensureCashPaymentsTables };
