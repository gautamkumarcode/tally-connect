/**
 * tally-connect — Office Laptop Agent (production, multi-type, incremental)
 *
 * WHAT IT DOES (per run):
 *   1. Connects to MongoDB Atlas (the MAIN Encon_Dashboard DB)
 *   2. For each configured voucher TYPE (e.g. Credit Note, Sales, Payment...):
 *        - reads a per-type CHECKPOINT (last synced date) from tally_sync_state
 *        - first run  -> backfills from TALLY_BACKFILL_FROM up to today
 *          later runs -> only pulls vouchers SINCE the checkpoint (+ overlap)
 *        - splits the window into date CHUNKS so no single Tally request is huge
 *          (Tally's HTTP server is single-threaded and chokes on big exports)
 *        - parses each chunk and BATCH-upserts into tally_vouchers
 *        - advances the checkpoint only after a clean run for that type
 *   3. Exits 0 on success, 1 on fatal failure (writes a one-line status file
 *      that sync-tally.bat turns into a plain-language message).
 *
 * CONFIG lives in .env next to the .exe (see tally-connect/.env).
 *
 * DEPLOYMENT: self-contained tally-agent.exe (built via @yao-pkg/pkg) — the
 *   office laptop does NOT need Node.js.
 *
 * TALLY PREREQ (one-time): Gateway of Tally → F12 → Connectivity → HTTP port 9000.
 */

import dotenv from 'dotenv';
import axios from 'axios';
import * as xml2js from 'xml2js';
import mongoose, { Schema, Document } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';

// In the packaged .exe, __dirname points inside the read-only snapshot bundle,
// so .env, logs and the status file must live next to the executable.
const RUN_DIR = (process as any).pkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

dotenv.config({ path: path.join(RUN_DIR, '.env') });

// ---------------------------------------------------------------------------
// Logger — console + optional rotating file + one-line status for the .bat
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(RUN_DIR, 'tally-connect.log');
const NOTIFY_FILE = path.join(RUN_DIR, 'last-sync-status.txt');
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
const MAX_LOG_BYTES = 500 * 1024;

function log(level: 'INFO' | 'WARN' | 'ERROR', ...args: any[]): void {
  const prefix = `[${new Date().toISOString()}] [${level}]`;
  const message = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](prefix, ...args);

  const statusArg = args.find((a) => String(a).includes('SYNC_'));
  if (statusArg) {
    try { fs.writeFileSync(NOTIFY_FILE, String(statusArg).trim(), 'utf8'); } catch (_e) { /* ignore */ }
  }

  if (LOG_TO_FILE) {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.writeFileSync(LOG_FILE, '');
      fs.appendFileSync(LOG_FILE, `${prefix} ${message}\n`, 'utf8');
    } catch (_e) { /* don't crash on log write */ }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_TYPES = 'Credit Note,Sales,Purchase,Receipt,Payment,Contra';

const CONFIG = {
  host: (process.env.TALLY_HOST || 'http://localhost:9000').trim(),
  company: (process.env.TALLY_COMPANY_NAME || '').trim(),
  types: (process.env.TALLY_VOUCHER_TYPES || DEFAULT_TYPES)
    .split(',').map((t) => t.trim()).filter(Boolean),
  backfillFrom: (process.env.TALLY_BACKFILL_FROM || '').trim(), // YYYYMMDD; empty => current FY start
  chunkMonths: Math.max(1, parseInt(process.env.TALLY_CHUNK_MONTHS || '12', 10) || 12),
  overlapDays: Math.max(0, parseInt(process.env.TALLY_OVERLAP_DAYS || '2', 10) || 0),
  batchSize: Math.max(1, parseInt(process.env.TALLY_BATCH_SIZE || '500', 10) || 500),
  timeoutMs: Math.max(10000, parseInt(process.env.TALLY_TIMEOUT_MS || '60000', 10) || 60000),
  retries: Math.max(0, parseInt(process.env.TALLY_RETRIES || '2', 10) || 0),
  // Optional slim TDL report name; if set, used instead of "Voucher Register".
  tdlReport: (process.env.TALLY_TDL_REPORT || '').trim(),
  // Books (position/outstanding) — Debtors, Creditors, Bank. Computed by the
  // agent from a lightweight INLINE-TDL ledger export (no .tdl file, no voucher
  // dump). See computeBooks().
  syncBooks: (process.env.TALLY_SYNC_BOOKS || 'false').trim().toLowerCase() === 'true',
  booksAsAt: (process.env.TALLY_BOOKS_AS_AT || '').trim(), // YYYYMMDD; empty => today
  // Force a full re-parse from TALLY_BACKFILL_FROM, ignoring the incremental
  // checkpoint. Needed after a parser fix so historical rows (e.g. vouchers the
  // old exe wrote with amount 0) get overwritten with correct values. Set to
  // 'true', run once, then set back to 'false'.
  forceFullSync: (process.env.TALLY_FORCE_FULL_SYNC || 'false').trim().toLowerCase() === 'true',
  // Standard Tally group names used to bucket ledgers (walk up the group tree).
  grpDebtors:   (process.env.TALLY_GRP_DEBTORS   || 'Sundry Debtors').trim(),
  grpCreditors: (process.env.TALLY_GRP_CREDITORS || 'Sundry Creditors').trim(),
  // Bank tab buckets every ledger under ANY of these groups. Tally's Cash/Bank
  // Summary spans "Bank Accounts" AND "Bank OD A/c" (overdraft/CC/loan a/cs), so
  // both are included by default. Comma-separated; override via env.
  grpBank:      (process.env.TALLY_GRP_BANK      || 'Bank Accounts,Bank OD A/c')
    .split(',').map((t) => t.trim()).filter(Boolean),
  grpCash:      (process.env.TALLY_GRP_CASH      || 'Cash-in-hand').trim(),
  // Voucher types whose ledger entries can post to a bank/cash account. Used by
  // syncBankTransactions() to build the per-bank transaction ledger.
  bankTxnTypes: (process.env.TALLY_BANK_TXN_TYPES || 'Contra,Payment,Receipt,Bank')
    .split(',').map((t) => t.trim()).filter(Boolean),
};

// ---------------------------------------------------------------------------
// Models — MUST mirror backend/src/models/TallyVoucher.ts
// ---------------------------------------------------------------------------
interface ITallyVoucher extends Document {
  company: string;
  voucherType: string;
  voucherNumber: string;
  date: Date;
  partyName: string;
  amount: number;
  syncedAt: Date;
}
const TallyVoucherSchema = new Schema<ITallyVoucher>(
  {
    company:       { type: String, required: true, trim: true },
    voucherType:   { type: String, required: true, trim: true },
    voucherNumber: { type: String, required: true, trim: true },
    date:          { type: Date,   required: true },
    partyName:     { type: String, required: true, trim: true },
    amount:        { type: Number, required: true, default: 0 },
    syncedAt:      { type: Date,   default: Date.now },
  },
  { collection: 'tally_vouchers' }
);
// Voucher numbers repeat across types (Payment #1 and Sales #1 both exist),
// so uniqueness is per company+type+number.
TallyVoucherSchema.index({ company: 1, voucherType: 1, voucherNumber: 1 }, { unique: true });
TallyVoucherSchema.index({ date: -1 });
const TallyVoucher = mongoose.models.TallyVoucher || mongoose.model<ITallyVoucher>('TallyVoucher', TallyVoucherSchema);

interface ISyncState extends Document {
  key: string;          // `${company}::${voucherType}`
  lastSyncedTo: Date;   // high-water mark of voucher dates synced
  updatedAt: Date;
}
const SyncStateSchema = new Schema<ISyncState>(
  {
    key:          { type: String, required: true, unique: true },
    lastSyncedTo: { type: Date,   required: true },
    updatedAt:    { type: Date,   default: Date.now },
  },
  { collection: 'tally_sync_state' }
);
const SyncState = mongoose.models.SyncState || mongoose.model<ISyncState>('SyncState', SyncStateSchema);

// TallyBook — MUST mirror backend/src/models/TallyBook.ts. One row per party
// (Debtors/Creditors/Bank balances) or per open order (Sales/Purchase Orders).
interface ITallyBook extends Document {
  company: string;
  category: string;
  name: string;
  ref: string;
  date: Date | null;
  amount: number;
  opening: number;
  syncedAt: Date;
}
const TallyBookSchema = new Schema<ITallyBook>(
  {
    company:  { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    name:     { type: String, required: true, trim: true },
    ref:      { type: String, default: '', trim: true },
    date:     { type: Date,   default: null },
    amount:   { type: Number, required: true, default: 0 },
    opening:  { type: Number, default: 0 },
    syncedAt: { type: Date,   default: Date.now },
  },
  { collection: 'tally_books' }
);
TallyBookSchema.index({ company: 1, category: 1, name: 1, ref: 1 }, { unique: true });
TallyBookSchema.index({ category: 1, amount: -1 });
const TallyBook = mongoose.models.TallyBook || mongoose.model<ITallyBook>('TallyBook', TallyBookSchema);

// TallyBankTxn — MUST mirror backend/src/models/TallyBankTxn.ts. One row per
// bank/cash ledger posting (a voucher can touch two banks, e.g. Contra), so we
// store the debit/credit as it affects THAT bank. Running balance is computed at
// read time from the bank's opening balance.
interface ITallyBankTxn extends Document {
  company: string;
  bank: string;
  date: Date;
  voucherType: string;
  voucherNumber: string;
  party: string;
  narration: string;
  debit: number;
  credit: number;
  syncedAt: Date;
}
const TallyBankTxnSchema = new Schema<ITallyBankTxn>(
  {
    company:       { type: String, required: true, trim: true },
    bank:          { type: String, required: true, trim: true },
    date:          { type: Date,   required: true },
    voucherType:   { type: String, default: '', trim: true },
    voucherNumber: { type: String, default: '', trim: true },
    party:         { type: String, default: '', trim: true },
    narration:     { type: String, default: '' },
    debit:         { type: Number, default: 0 },
    credit:        { type: Number, default: 0 },
    syncedAt:      { type: Date,   default: Date.now },
  },
  { collection: 'tally_bank_txn' }
);
TallyBankTxnSchema.index({ company: 1, bank: 1, date: 1, voucherType: 1, voucherNumber: 1 });
const TallyBankTxn = mongoose.models.TallyBankTxn || mongoose.model<ITallyBankTxn>('TallyBankTxn', TallyBankTxnSchema);

async function connectDB(): Promise<void> {
  const uri = (process.env.TALLY_MONGODB_URI || '').trim();
  if (!uri || uri.includes('YOUR_TALLY')) throw new Error('TALLY_MONGODB_URI is not configured in .env');
  log('INFO', 'Connecting to MongoDB Atlas (Encon_Dashboard)...');
  await mongoose.connect(uri, { maxPoolSize: 3, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
  log('INFO', '✅ MongoDB connected');
}

// ---------------------------------------------------------------------------
// Date helpers (Tally uses YYYYMMDD)
// ---------------------------------------------------------------------------
function toTallyDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}`;
}
function fromTallyDate(s: string): Date {
  return new Date(Date.UTC(+s.substring(0, 4), +s.substring(4, 6) - 1, +s.substring(6, 8)));
}
function addUTCMonths(d: Date, months: number): Date {
  const x = new Date(d.getTime());
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, lastDay));
  return x;
}
function addUTCDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}
// Start of the current Indian financial year (1 April).
function currentFyStart(now: Date): Date {
  const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1));
}

// ---------------------------------------------------------------------------
// Tally request builders
// ---------------------------------------------------------------------------
function buildRequest(company: string, voucherType: string, from: string, to: string): string {
  const reportName = CONFIG.tdlReport || 'Voucher Register';
  // When no company name is configured we OMIT SVCURRENTCOMPANY entirely — Tally
  // then exports from whichever company is currently OPEN (verified working).
  const companyLine = company ? `      <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>\n` : '';
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
${companyLine}      <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
      <SVFROMDATE>${from}</SVFROMDATE>
      <SVTODATE>${to}</SVTODATE>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

async function postToTally(body: string, label: string): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    try {
      const res = await axios.post(CONFIG.host, body, {
        headers: { 'Content-Type': 'text/xml' },
        timeout: CONFIG.timeoutMs,
        responseType: 'text',
      });
      return res.data as string;
    } catch (err: any) {
      lastErr = err;
      if (attempt < CONFIG.retries) {
        log('WARN', `  retry ${attempt + 1}/${CONFIG.retries} for ${label}: ${err?.message}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

async function fetchWindow(voucherType: string, from: string, to: string): Promise<string> {
  return postToTally(buildRequest(CONFIG.company, voucherType, from, to), `${voucherType} ${from}-${to}`);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// When no company is configured, ask Tally (with SVCURRENTCOMPANY omitted) and
// read back the exact name it echoes — that is the currently-open company.
async function detectActiveCompany(): Promise<string> {
  const today = new Date();
  const body = buildRequest('', CONFIG.types[0] || 'Payment', toTallyDate(currentFyStart(today)), toTallyDate(today));
  const xml = await postToTally(body, 'company-detect');
  const m = xml.match(/<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

// ---------------------------------------------------------------------------
// XML parsing (sanitizes Tally's illegal entities; robust amount/party)
// ---------------------------------------------------------------------------
function extractField(node: any, ...keys: string[]): string {
  for (const key of keys) {
    const val = node[key];
    if (Array.isArray(val) && val.length > 0) return String(val[0]).trim();
    if (val && typeof val === 'string') return val.trim();
  }
  return '';
}

function sanitizeXml(xml: string): string {
  const legal = (n: number) => n === 9 || n === 10 || n === 13 || n >= 32;
  return xml
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (m, d) => (legal(parseInt(d, 10)) ? m : ''))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => (legal(parseInt(h, 16)) ? m : ''))
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

// When a window returns 0 vouchers, work out WHY from the raw XML so the log is
// self-explanatory instead of a silent "0 rows".
function detectTallyIssue(xml: string): string {
  const le = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
  if (le) {
    const msg = decodeEntities(le[1]).trim();
    if (/SVCurrentCompany/i.test(msg)) {
      return `Tally reported: "${msg}". The TALLY_COMPANY_NAME does not EXACTLY match the company loaded in Tally. Leave TALLY_COMPANY_NAME blank in .env to auto-use the open company, or set it to the precise name.`;
    }
    return `Tally reported an error: "${msg}".`;
  }
  const err = xml.match(/<ERRDESC>([\s\S]*?)<\/ERRDESC>/i);
  if (err || /does not exist|no such|invalid company|<MASTERNAME>\s*Company/i.test(xml)) {
    return `Tally returned an ERROR${err ? ': "' + err[1].trim() + '"' : ''}. The TALLY_COMPANY_NAME in .env most likely does not EXACTLY match the company loaded in Tally (check case & punctuation against the Tally gateway title bar).`;
  }
  if (/<TALLYMESSAGE/i.test(xml) && !/<VOUCHER[ >]/i.test(xml)) {
    return 'Tally responded but contained NO voucher nodes — usually a company-name mismatch or that type genuinely has no vouchers in the period.';
  }
  if (xml.trim().length < 200) {
    return 'Tally returned a near-empty response.';
  }
  return 'Tally responded but no vouchers were parsed.';
}

// Dump the first empty response to a file so it can be inspected/shared.
let emptyDumpWritten = false;
function dumpEmptyResponseOnce(type: string, xml: string): void {
  if (emptyDumpWritten) return;
  try {
    fs.writeFileSync(path.join(RUN_DIR, 'tally_debug_response.xml'), xml, 'utf8');
    emptyDumpWritten = true;
    log('WARN', `  (raw response saved to tally_debug_response.xml for diagnosis)`);
  } catch (_e) { /* ignore */ }
}

interface ParsedVoucher {
  company: string;
  voucherType: string;
  voucherNumber: string;
  date: Date;
  partyName: string;
  amount: number;
}

async function parseResponse(xmlString: string, requestedType: string): Promise<ParsedVoucher[]> {
  const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });
  const result = await parser.parseStringPromise(sanitizeXml(xmlString));

  const tallymessages: any[] =
    result?.ENVELOPE?.BODY?.[0]?.DATA?.[0]?.TALLYMESSAGE ||
    result?.ENVELOPE?.BODY?.[0]?.IMPORTDATA?.[0]?.REQUESTDATA?.[0]?.TALLYMESSAGE ||
    [];

  const out: ParsedVoucher[] = [];
  for (const msg of tallymessages) {
    for (const v of msg?.VOUCHER || []) {
      try {
        const voucherNumber = extractField(v, 'VOUCHERNUMBER', 'VOUCHER_NUMBER');
        const dateRaw = extractField(v, 'DATE', 'VOUCHERDATE');
        if (!voucherNumber || !dateRaw) continue;

        // Invoice-view vouchers (Sales/Purchase) put ledger postings under
        // LEDGERENTRIES.LIST, not ALLLEDGERENTRIES.LIST — check both. The bill
        // grand total is the PARTY-ledger contra entry (often the LAST entry, not
        // the first), so match it by name before any positional fallback.
        const allLed: any[] = v['ALLLEDGERENTRIES.LIST'] || [];
        const stdLed: any[] = v['LEDGERENTRIES.LIST'] || [];
        const entries: any[] = allLed.length ? allLed : stdLed;
        const firstEntryAmount = entries.length ? extractField(entries[0], 'AMOUNT', 'LEDGERAMOUNT') : '';
        const firstEntryParty = entries.length ? extractField(entries[0], 'LEDGERNAME', 'LEDGER') : '';

        const vchType = extractField(v, 'VOUCHERTYPENAME') || requestedType;
        const isFundType = ['payment', 'receipt', 'contra', 'fund'].includes(vchType.toLowerCase());

        let amount = 0;
        if (!isFundType) {
          const partyLedger = extractField(v, 'PARTYLEDGERNAME', 'PARTYNAME');
          if (partyLedger) {
            for (const e of entries) {
              if (extractField(e, 'LEDGERNAME', 'LEDGER') === partyLedger) {
                amount = Math.abs(parseFloat(extractField(e, 'AMOUNT', 'LEDGERAMOUNT')) || 0);
                if (amount) break;
              }
            }
          }
        }
        if (!amount) {
          const amountRaw = extractField(v, 'AMOUNT', 'GRANDTOTAL', 'BASICPARENTTOTAL', 'LEDGERAMOUNT');
          amount = Math.abs(parseFloat(amountRaw) || 0);
        }
        if (!amount) amount = Math.abs(parseFloat(firstEntryAmount) || 0);

        let partyName = isFundType
          ? (firstEntryParty || extractField(v, 'PARTYLEDGERNAME'))
          : extractField(v, 'PARTYLEDGERNAME', 'PARTYNAME', 'PARTY_NAME');
        if (!partyName) partyName = firstEntryParty;

        const date = fromTallyDate(dateRaw);
        if (isNaN(date.getTime())) continue;

        out.push({
          company: CONFIG.company,
          voucherType: vchType,
          voucherNumber,
          date,
          partyName: partyName || 'Unknown Party',
          amount,
        });
      } catch (_e) { /* skip malformed node */ }
    }
  }
  return out;
}

async function upsertBatch(vouchers: ParsedVoucher[]): Promise<{ upserted: number; modified: number }> {
  let upserted = 0, modified = 0;
  for (let i = 0; i < vouchers.length; i += CONFIG.batchSize) {
    const slice = vouchers.slice(i, i + CONFIG.batchSize);
    const ops = slice.map((v) => ({
      updateOne: {
        filter: { company: v.company, voucherType: v.voucherType, voucherNumber: v.voucherNumber },
        update: { $set: { date: v.date, partyName: v.partyName, amount: v.amount, syncedAt: new Date() } },
        upsert: true,
      },
    }));
    const r = await TallyVoucher.bulkWrite(ops, { ordered: false });
    upserted += r.upsertedCount || 0;
    modified += r.modifiedCount || 0;
  }
  return { upserted, modified };
}

// ---------------------------------------------------------------------------
// Books (position/outstanding) — Debtors, Creditors, Bank.
//
// Tally's HTTP interface will NOT export a pre-built party-balance report, and
// the full Voucher Register dump is ~60 MB and freezes the single-threaded
// server. Instead we send a tiny AD-HOC (inline) TDL definition *inside the
// request body* — Tally runs it and returns just the ledger masters
// (Name, Parent group, Closing Balance) in ~1 MB / under a second, with NO
// .tdl file to load on the user's machine.
//
// We then roll each ledger up the group tree (Parent chain) to bucket it as a
// Debtor / Creditor / Bank and write one row per party into tally_books.
//
// Verified against the live company: the Sundry Creditors debit total matched
// the on-screen Group Summary to the paisa. Sign convention in $ClosingBalance
// is negative = Debit, positive = Credit.
// ---------------------------------------------------------------------------
function inlineTdlExport(objectType: string, fetch: string, id: string, asAt: string, from: string): string {
  const companyLine = CONFIG.company ? `<SVCURRENTCOMPANY>${CONFIG.company}</SVCURRENTCOMPANY>` : '';
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${id}</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyLine}<SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${asAt}</SVTODATE></STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <REPORT NAME="${id}"><FORMS>F1</FORMS><VARIABLE>SVEXPORTFORMAT,SVCURRENTCOMPANY,SVFROMDATE,SVTODATE</VARIABLE></REPORT>
   <FORM NAME="F1"><PARTS>P1</PARTS><XMLTAG>"Root"</XMLTAG></FORM>
   <PART NAME="P1"><LINES>L1</LINES><REPEAT>L1 : C1</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
   <LINE NAME="L1"><XMLTAG>"Row"</XMLTAG><FIELDS>F1N,F1P,F1O,F1B</FIELDS></LINE>
   <FIELD NAME="F1N"><SET>$Name</SET></FIELD>
   <FIELD NAME="F1P"><SET>$Parent</SET></FIELD>
   <FIELD NAME="F1O"><SET>$OpeningBalance</SET><TYPE>Amount</TYPE></FIELD>
   <FIELD NAME="F1B"><SET>$ClosingBalance</SET><TYPE>Amount</TYPE></FIELD>
   <COLLECTION NAME="C1"><TYPE>${objectType}</TYPE><FETCH>${fetch}</FETCH></COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
}

interface InlineRow { name: string; parent: string; opening: number; balance: number; }

// Extract <ROW> blocks emitted by inlineTdlExport (tags come back UPPERCASE).
function parseInlineRows(xml: string): InlineRow[] {
  const out: InlineRow[] = [];
  const rowRe = /<ROW>([\s\S]*?)<\/ROW>/gi;
  const grab = (s: string, tag: string) => { const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i').exec(s); return m ? m[1].trim() : ''; };
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml))) {
    out.push({
      name: decodeEntities(grab(m[1], 'F1N')),
      parent: decodeEntities(grab(m[1], 'F1P')),
      opening: parseFloat(grab(m[1], 'F1O')) || 0,
      balance: parseFloat(grab(m[1], 'F1B')) || 0,
    });
  }
  return out;
}

async function upsertBookBatch(rows: any[]): Promise<{ upserted: number; modified: number }> {
  let upserted = 0, modified = 0;
  for (let i = 0; i < rows.length; i += CONFIG.batchSize) {
    const slice = rows.slice(i, i + CONFIG.batchSize);
    const ops = slice.map((v: any) => ({
      updateOne: {
        filter: { company: v.company, category: v.category, name: v.name, ref: v.ref },
        update: { $set: { date: v.date, amount: v.amount, opening: v.opening || 0, syncedAt: new Date() } },
        upsert: true,
      },
    }));
    const r = await TallyBook.bulkWrite(ops, { ordered: false });
    upserted += r.upsertedCount || 0;
    modified += r.modifiedCount || 0;
  }
  return { upserted, modified };
}

// Map of bank/cash ledger name -> 'Bank' | 'Cash', populated by computeBooks and
// consumed by syncBankTransactions() to attribute voucher postings to accounts.
let LEDGER_BUCKET: Record<string, 'Bank' | 'Cash'> = {};

async function computeBooks(): Promise<{ type: string; count: number; ok: boolean }> {
  const asAt = CONFIG.booksAsAt && /^\d{8}$/.test(CONFIG.booksAsAt) ? CONFIG.booksAsAt : toTallyDate(new Date());
  // Period start = 1 April of the current financial year, so $OpeningBalance is
  // the balance at the start of the FY (matches Tally's "1-Apr-xx to as-at").
  const from = toTallyDate(currentFyStart(new Date()));
  try {
    const groupsXml = await postToTally(inlineTdlExport('Group', 'Name, Parent', 'ENCONGRP', asAt, from), 'books groups');
    const ledgersXml = await postToTally(inlineTdlExport('Ledger', 'Name, Parent, OpeningBalance, ClosingBalance', 'ENCONLED', asAt, from), 'books ledgers');
    if (/<LINEERROR>/i.test(ledgersXml) || !/<ROW[ >]/i.test(ledgersXml)) {
      log('WARN', `  books: no ledger rows returned — ${detectTallyIssue(ledgersXml)}`);
      return { type: 'Books', count: 0, ok: false };
    }
    const parentOf: Record<string, string> = {};
    for (const g of parseInlineRows(groupsXml)) parentOf[g.name] = g.parent;
    // Is `start` (a ledger's parent group) the target group or a descendant of it?
    const under = (start: string, target: string): boolean => {
      let cur = start, d = 0;
      while (cur && d++ < 25) { if (cur === target) return true; cur = parentOf[cur]; }
      return false;
    };
    const docs: any[] = [];
    LEDGER_BUCKET = {};
    for (const l of parseInlineRows(ledgersXml)) {
      if (!l.name) continue;
      // Categorise first, so banks/cash can be treated differently re: zero balance.
      // Sign multiplier: display positive = the party's NORMAL side.
      //   Debtors/Bank/Cash -> Dr normal (raw negative = Dr), multiply by -1.
      //   Creditors         -> Cr normal (raw positive = Cr), multiply by +1.
      let category = '', sign = 0;
      if (under(l.parent, CONFIG.grpDebtors))       { category = 'Debtors';   sign = -1; }
      else if (under(l.parent, CONFIG.grpCreditors)){ category = 'Creditors'; sign =  1; }
      else if (CONFIG.grpBank.some((g) => under(l.parent, g))) { category = 'Bank'; sign = -1; }
      else if (under(l.parent, CONFIG.grpCash))     { category = 'Cash';       sign = -1; }
      if (!category) continue;
      // Always list every bank/cash account (even a zero balance) so the Bank tab
      // shows all accounts; only Debtors/Creditors skip parties with no balance.
      if ((category === 'Debtors' || category === 'Creditors') && Math.abs(l.balance) < 0.5 && Math.abs(l.opening) < 0.5) continue;
      if (category === 'Bank' || category === 'Cash') LEDGER_BUCKET[l.name] = category;
      const amount = Math.round(sign * l.balance * 100) / 100;
      const opening = Math.round(sign * l.opening * 100) / 100;
      docs.push({ company: CONFIG.company, category, name: l.name, ref: '', date: null, amount, opening });
    }
    // Replace the balance snapshot for these categories (leave Orders rows intact).
    await TallyBook.deleteMany({ company: CONFIG.company, category: { $in: ['Debtors', 'Creditors', 'Bank', 'Cash'] } });
    if (docs.length) await upsertBookBatch(docs);
    const byCat: Record<string, number> = {};
    for (const d of docs) byCat[d.category] = (byCat[d.category] || 0) + 1;
    log('INFO', `  Books: ${docs.length} rows (Debtors ${byCat['Debtors'] || 0}, Creditors ${byCat['Creditors'] || 0}, Bank ${byCat['Bank'] || 0}, Cash ${byCat['Cash'] || 0})`);
    return { type: 'Books', count: docs.length, ok: true };
  } catch (err: any) {
    log('ERROR', `  Books FAILED: ${err?.message}`);
    return { type: 'Books', count: 0, ok: false };
  }
}

// Build the per-bank / per-cash transaction ledger. For each fund voucher type
// (Contra/Payment/Receipt/Bank) we read every ledger posting; where the posting
// is a bank/cash account we store one row recording that account's debit/credit
// for the voucher. ISDEEMEDPOSITIVE: 'Yes' = Debit (money in), 'No' = Credit
// (money out). A voucher touching two banks (Contra) yields two rows. Running
// balance is derived at read time from the account's opening balance.
async function syncBankTransactions(): Promise<{ type: string; count: number; ok: boolean }> {
  const asAt = CONFIG.booksAsAt && /^\d{8}$/.test(CONFIG.booksAsAt) ? CONFIG.booksAsAt : toTallyDate(new Date());
  const from = toTallyDate(currentFyStart(new Date()));
  const fromDate = fromTallyDate(from);
  try {
    // Ensure the bank/cash ledger-name set exists (computeBooks fills it; build it
    // here too so this step also works standalone).
    if (!Object.keys(LEDGER_BUCKET).length) {
      const groupsXml = await postToTally(inlineTdlExport('Group', 'Name, Parent', 'ENCONGRP', asAt, from), 'banktxn groups');
      const ledgersXml = await postToTally(inlineTdlExport('Ledger', 'Name, Parent', 'ENCONLED', asAt, from), 'banktxn ledgers');
      const parentOf: Record<string, string> = {};
      for (const g of parseInlineRows(groupsXml)) parentOf[g.name] = g.parent;
      const under = (start: string, target: string): boolean => { let cur = start, d = 0; while (cur && d++ < 25) { if (cur === target) return true; cur = parentOf[cur]; } return false; };
      for (const l of parseInlineRows(ledgersXml)) {
        if (!l.name) continue;
        if (CONFIG.grpBank.some((g) => under(l.parent, g))) LEDGER_BUCKET[l.name] = 'Bank';
        else if (under(l.parent, CONFIG.grpCash)) LEDGER_BUCKET[l.name] = 'Cash';
      }
    }
    const bankNames = new Set(Object.keys(LEDGER_BUCKET));
    if (!bankNames.size) { log('WARN', '  bank txn: no bank/cash ledgers found; skipping'); return { type: 'BankTxn', count: 0, ok: true }; }

    const parser = new xml2js.Parser({ explicitArray: true, ignoreAttrs: false });
    const txnDocs: any[] = [];
    for (const type of CONFIG.bankTxnTypes) {
      let xml: string;
      try { xml = await fetchWindow(type, from, asAt); }
      catch (e: any) { log('WARN', `  bank txn ${type}: fetch failed — ${e?.message}`); continue; }
      if (/<LINEERROR>/i.test(xml)) { log('WARN', `  bank txn ${type}: ${detectTallyIssue(xml)}`); continue; }
      let result: any;
      try { result = await parser.parseStringPromise(sanitizeXml(xml)); }
      catch (e: any) { log('WARN', `  bank txn ${type}: parse failed — ${e?.message}`); continue; }
      const msgs: any[] =
        result?.ENVELOPE?.BODY?.[0]?.DATA?.[0]?.TALLYMESSAGE ||
        result?.ENVELOPE?.BODY?.[0]?.IMPORTDATA?.[0]?.REQUESTDATA?.[0]?.TALLYMESSAGE || [];
      let before = txnDocs.length;
      for (const msg of msgs) {
        for (const v of msg?.VOUCHER || []) {
          const dateRaw = extractField(v, 'DATE', 'VOUCHERDATE');
          if (!dateRaw) continue;
          const date = fromTallyDate(dateRaw);
          if (isNaN(date.getTime()) || date < fromDate) continue; // Tally ignores from-date; enforce FY
          const number = extractField(v, 'VOUCHERNUMBER');
          const narration = decodeEntities(extractField(v, 'NARRATION'));
          const entries: any[] = v['ALLLEDGERENTRIES.LIST'] || [];
          for (const be of entries) {
            const bank = extractField(be, 'LEDGERNAME');
            if (!bankNames.has(bank)) continue;
            const amt = Math.abs(parseFloat(extractField(be, 'AMOUNT')) || 0);
            if (amt < 0.005) continue;
            const isDebit = extractField(be, 'ISDEEMEDPOSITIVE').toLowerCase() === 'yes';
            // Counterparty = the largest other ledger entry (not this bank).
            let other = '', best = -1;
            for (const e of entries) {
              const nm = extractField(e, 'LEDGERNAME');
              if (!nm || nm === bank) continue;
              const a = Math.abs(parseFloat(extractField(e, 'AMOUNT')) || 0);
              if (a > best) { best = a; other = nm; }
            }
            txnDocs.push({ company: CONFIG.company, bank, date, voucherType: type, voucherNumber: number, party: other, narration, debit: isDebit ? amt : 0, credit: isDebit ? 0 : amt });
          }
        }
      }
      log('INFO', `  bank txn ${type}: ${txnDocs.length - before} postings`);
    }

    await TallyBankTxn.deleteMany({ company: CONFIG.company });
    for (let i = 0; i < txnDocs.length; i += CONFIG.batchSize) {
      await TallyBankTxn.insertMany(txnDocs.slice(i, i + CONFIG.batchSize), { ordered: false });
    }
    const banks = new Set(txnDocs.map((t) => t.bank));
    log('INFO', `  Bank transactions: ${txnDocs.length} postings across ${banks.size} accounts`);
    return { type: 'BankTxn', count: txnDocs.length, ok: true };
  } catch (err: any) {
    log('ERROR', `  Bank transactions FAILED: ${err?.message}`);
    return { type: 'BankTxn', count: 0, ok: false };
  }
}

// ---------------------------------------------------------------------------
// Per-type sync with checkpoint + date chunking
// ---------------------------------------------------------------------------
async function syncType(voucherType: string): Promise<{ type: string; count: number; ok: boolean }> {
  const key = `${CONFIG.company}::${voucherType}`;
  const today = new Date();
  const windowEnd = today;

  const state: { lastSyncedTo: Date } | null = await SyncState.findOne({ key }).lean().exec() as any;
  let windowStart: Date;
  if (state && state.lastSyncedTo && !CONFIG.forceFullSync) {
    // Re-pull a small overlap so vouchers edited/added just before the mark are caught.
    windowStart = addUTCDays(new Date(state.lastSyncedTo), -CONFIG.overlapDays);
    log('INFO', `[${voucherType}] incremental: ${toTallyDate(windowStart)} → ${toTallyDate(windowEnd)}`);
  } else {
    const backfill = CONFIG.backfillFrom && /^\d{8}$/.test(CONFIG.backfillFrom)
      ? fromTallyDate(CONFIG.backfillFrom)
      : currentFyStart(today);
    windowStart = backfill;
    log('INFO', `[${voucherType}] backfill: ${toTallyDate(windowStart)} → ${toTallyDate(windowEnd)}`);
  }

  // Build the list of date windows to request.
  //
  // IMPORTANT (verified against Tally Prime): the built-in "Voucher Register"
  // report honours only the upper bound (SVTODATE) and IGNORES SVFROMDATE — it
  // returns every voucher dated up to "to". Splitting such a report into
  // increasing "to" chunks would therefore re-pull all earlier history in every
  // chunk (cumulative, wasteful). So with the stock report we make a SINGLE
  // request up to today. Chunking (and true incremental) is only used when a
  // custom date-filtering TDL report is configured via TALLY_TDL_REPORT.
  const windows: Array<[string, string]> = [];
  if (CONFIG.tdlReport) {
    let cursor = windowStart;
    while (cursor <= windowEnd) {
      const chunkEnd = addUTCDays(addUTCMonths(cursor, CONFIG.chunkMonths), -1);
      const effEnd = chunkEnd > windowEnd ? windowEnd : chunkEnd;
      windows.push([toTallyDate(cursor), toTallyDate(effEnd)]);
      cursor = addUTCDays(effEnd, 1);
    }
  } else {
    windows.push([toTallyDate(windowStart), toTallyDate(windowEnd)]);
  }

  let total = 0;
  for (const [from, to] of windows) {
    try {
      const xml = await fetchWindow(voucherType, from, to);
      const vouchers = await parseResponse(xml, voucherType);
      if (vouchers.length) {
        const { upserted, modified } = await upsertBatch(vouchers);
        total += vouchers.length;
        log('INFO', `  ${voucherType} ${from}→${to}: ${vouchers.length} rows (ins ${upserted}/upd ${modified})`);
      } else {
        log('WARN', `  ${voucherType} ${from}→${to}: 0 rows — ${detectTallyIssue(xml)}`);
        log('WARN', `  raw response (first 240 chars): ${JSON.stringify(xml.substring(0, 240))}`);
        dumpEmptyResponseOnce(voucherType, xml);
      }
    } catch (err: any) {
      // Do NOT advance the checkpoint past a failed window — retry next run.
      log('ERROR', `  ${voucherType} ${from}→${to} FAILED: ${err?.message}`);
      return { type: voucherType, count: total, ok: false };
    }
  }

  // Advance checkpoint to the end of the successfully-synced window.
  await SyncState.updateOne(
    { key },
    { $set: { key, lastSyncedTo: windowEnd, updatedAt: new Date() }, $setOnInsert: {} },
    { upsert: true }
  );
  log('INFO', `[${voucherType}] done — ${total} rows, checkpoint → ${toTallyDate(windowEnd)}`);
  return { type: voucherType, count: total, ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runAgent(): Promise<void> {
  const startTime = Date.now();
  log('INFO', '══════════════════════════════════════════');
  log('INFO', '  Tally Connect Agent — sync run');
  log('INFO', `  Company: ${CONFIG.company ? `"${CONFIG.company}"` : '(auto — use open company)'}  Types: ${CONFIG.types.join(', ')}`);
  if (CONFIG.syncBooks) log('INFO', '  Books: Debtors, Creditors, Bank, Cash (+ per-bank transactions)');
  log('INFO', '══════════════════════════════════════════');

  if (!CONFIG.types.length) {
    log('ERROR', 'SYNC_FAILED_CONFIG: TALLY_VOUCHER_TYPES is empty.');
    process.exit(1);
  }

  // No company name configured -> detect the one currently open in Tally.
  if (!CONFIG.company || CONFIG.company === 'YOUR_COMPANY_NAME_HERE') {
    log('INFO', '  No TALLY_COMPANY_NAME set — detecting the company currently open in Tally...');
    try {
      const detected = await detectActiveCompany();
      if (detected) {
        CONFIG.company = detected;
        log('INFO', `  ✅ Detected open company: "${detected}"`);
      } else {
        log('ERROR', 'SYNC_FAILED_CONFIG: Could not detect an open company. Open the Encon company in Tally (be inside its Gateway of Tally), then retry.');
        process.exit(1);
      }
    } catch (err: any) {
      log('ERROR', `SYNC_FAILED_TALLY_CLOSED: Could not reach Tally to detect the company: ${err?.message}`);
      process.exit(1);
    }
  }

  await connectDB();

  const results: { type: string; count: number; ok: boolean }[] = [];
  let tallyUnreachable = false;
  for (const type of CONFIG.types) {
    try {
      results.push(await syncType(type));
    } catch (err: any) {
      const msg = String(err?.message || err);
      // A connection-level failure (Tally closed / port down) is fatal-ish.
      if (/ECONNREFUSED|socket hang up|timeout|remote server|closed/i.test(msg)) tallyUnreachable = true;
      log('ERROR', `SYNC_FAILED_TALLY_CLOSED: ${type} sync aborted: ${msg}`);
      results.push({ type, count: 0, ok: false });
    }
  }
  const voucherFailed = results.filter((r) => !r.ok).length;

  // Books (position/outstanding) — Debtors, Creditors, Bank, Cash + per-bank txns.
  if (CONFIG.syncBooks && !tallyUnreachable) {
    log('INFO', '── Books (Debtors / Creditors / Bank / Cash) ──');
    results.push(await computeBooks());
    results.push(await syncBankTransactions());
  }

  const totalRows = results.reduce((s, r) => s + r.count, 0);
  const failed = results.filter((r) => !r.ok);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log('INFO', '──────────────────────────────────────────');
  results.forEach((r) => log('INFO', `  ${r.ok ? 'OK ' : 'ERR'} ${r.type}: ${r.count} rows`));
  log('INFO', `  Total ${totalRows} rows in ${elapsed}s`);

  await mongoose.disconnect();

  if (tallyUnreachable && voucherFailed === CONFIG.types.length) {
    log('ERROR', 'SYNC_FAILED_TALLY_CLOSED: Could not reach Tally. Open Tally and retry.');
    process.exit(1);
  }
  if (failed.length) {
    log('WARN', `SYNC_SUCCESS: Partial — ${failed.map((f) => f.type).join(', ')} will retry next run.`);
  } else {
    log('INFO', `SYNC_SUCCESS: ${totalRows} rows synced across ${results.length} reports.`);
  }
  log('INFO', 'MongoDB disconnected. Agent exiting cleanly.');
  process.exit(0);
}

runAgent().catch((err: any) => {
  log('ERROR', 'Unhandled agent error:', err?.message || err);
  mongoose.disconnect().finally(() => process.exit(1));
});
