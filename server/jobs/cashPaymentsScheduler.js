// Cash Payments (2026-11-19, Hera): every day at 03:10 Toronto, fetch the
// System (Shopify cash net payments) of every day not fetched yet, from the
// Starting date to yesterday. Logic in server/services/cashPayments.js.
const cron = require('node-cron');
const { syncSystemAmounts } = require('../services/cashPayments');
// Preview & Test Mode (temporary): clear fake rows once the Starting date is
// reached, add fake Pending days while it is on — always before the real fetch.
const { maintain: maintainTestMode } = require('../services/cashPaymentsTest');
const run = (reason) => maintainTestMode().then(() => syncSystemAmounts(reason));

const TIMEZONE = 'America/Toronto';
let task = null;

function startCashPaymentsScheduler() {
  if (task) { task.stop(); task = null; }
  task = cron.schedule('10 3 * * *', () => { run('03:10 run'); }, { timezone: TIMEZONE });
  // Catch up shortly after boot (a night missed while the server was down).
  setTimeout(() => { run('startup'); }, 60 * 1000);
  console.log('[cash-payments] scheduler started (daily 03:10)');
}

module.exports = { startCashPaymentsScheduler };
