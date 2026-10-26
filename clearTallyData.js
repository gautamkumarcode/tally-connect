/**
 * clearTallyData.js — one-off maintenance script.
 *
 * Deletes ALL tally-related data from the MongoDB (EnconDashboard) database
 * configured in .env (TALLY_MONGODB_URI) for EVERY company.
 *
 * Targets: tally_vouchers, tally_books, tally_bank_txn, tally_sync_state
 * (+ legacy credit_notes if that collection still exists).
 *
 * Run:  node clearTallyData.js         (irreversible — deletes all rows)
 *       node clearTallyData.js --dry   (report counts only, delete nothing)
 */

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '.env') });

const DRY = process.argv.includes('--dry');
const TARGETS = ['tally_vouchers', 'tally_books', 'tally_bank_txn', 'tally_sync_state', 'credit_notes'];

async function main() {
  const uri = (process.env.TALLY_MONGODB_URI || '').trim();
  if (!uri || uri.includes('YOUR_TALLY')) {
    console.error('TALLY_MONGODB_URI is not configured in .env — nothing to do.');
    process.exit(1);
  }

  console.log(`Connecting to MongoDB${DRY ? ' (DRY RUN — no deletes)' : ''}...`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  console.log(`Connected to database: ${db.databaseName}\n`);

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  for (const name of TARGETS) {
    if (!existing.has(name)) {
      console.log(`- ${name}: collection does not exist — skipped`);
      continue;
    }
    const before = await db.collection(name).countDocuments({});
    if (DRY) {
      console.log(`- ${name}: ${before} document(s) [would delete]`);
    } else {
      await db.collection(name).deleteMany({});
      const after = await db.collection(name).countDocuments({});
      console.log(`- ${name}: deleted ${before} document(s) (remaining: ${after})`);
    }
  }

  await mongoose.disconnect();
  console.log(DRY ? '\nDry run complete — nothing was deleted.' : '\nAll tally data deleted. MongoDB disconnected.');
}

main().catch((err) => {
  console.error('FAILED:', err && err.message ? err.message : err);
  mongoose.disconnect().finally(() => process.exit(1));
});
