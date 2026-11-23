// Wig Try-on › Sale report (2026-11-23, Hera): every hour at :25 (Toronto), fetch
// from Shopify the orders of try-on customers whose 7-day window is open or not yet
// fetched. Logic in server/services/wigTryonSales.js.
const cron = require('node-cron');
const { syncCustomers } = require('../services/wigTryonSales');

const TIMEZONE = 'America/Toronto';
let task = null;

function startWigTryonSalesScheduler() {
  if (task) { task.stop(); task = null; }
  task = cron.schedule('25 * * * *', () => { syncCustomers('hourly'); }, { timezone: TIMEZONE });
  // First run a few minutes after boot (catch up after a restart).
  setTimeout(() => { syncCustomers('startup'); }, 3 * 60 * 1000);
  console.log('[wig-tryon sales] scheduler started (hourly :25)');
}

module.exports = { startWigTryonSalesScheduler };
