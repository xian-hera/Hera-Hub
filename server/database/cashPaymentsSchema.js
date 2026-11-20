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
