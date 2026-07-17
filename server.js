/**
 * server.js - Instagram Influencer Scraper Express server
 * Port: 5176
 */

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

import {
  scrapeInstagramTargets,
  checkInstagramConnectivity
} from './lib/instagram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5176);
const DATA_EXCEL_DIR = path.join(__dirname, 'data-excel');
const MAX_EXCEL_FILES = 5;
const MAX_LOGS = 500;

const deflateRaw = promisify(zlib.deflateRaw);

if (!existsSync(DATA_EXCEL_DIR)) mkdirSync(DATA_EXCEL_DIR, { recursive: true });

async function withDefaultCookieFile(options) {
  if (options.cookieStr || !process.env.IG_COOKIE_FILE) return options;
  try {
    return {
      ...options,
      cookieStr: await fs.readFile(process.env.IG_COOKIE_FILE, 'utf8')
    };
  } catch (e) {
    addLog(`Cookie file error: ${e.message}`);
    return options;
  }
}

const runner = {
  rows: [],
  logs: [],
  dataVersion: 0,
  logVersion: 0,
  seenUsernames: new Set(),
  running: false,
  stopping: false,
  currentTag: '',
  progress: null,
  options: {}
};

function addLog(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  runner.logs.push(entry);
  if (runner.logs.length > MAX_LOGS) runner.logs.shift();
  runner.logVersion++;
}

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function cellRef(col, row) {
  let c = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    c = String.fromCharCode(65 + rem) + c;
    n = Math.floor((n - 1) / 26);
  }
  return `${c}${row}`;
}

const COLS = [
  'scraped_at', 'platform', 'username', 'full_name', 'follower_count',
  'following_count', 'media_count', 'like_count', 'comment_count',
  'engagement_rate', 'country', 'country_source', 'region_raw', 'email',
  'email_source', 'email_url', 'external_urls', 'source_tags', 'caption',
  'post_url', 'thumbnail_url', 'biography', 'profile_url', 'profile_pic_url',
  'is_verified', 'is_private', 'category', 'source', 'popularity_score'
];

async function generateXlsx(rows) {
  function buildSheet() {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet">';
    xml += '<sheetData>';
    xml += '<row r="1">';
    for (let c = 0; c < COLS.length; c++) {
      xml += `<c r="${cellRef(c, 1)}" t="inlineStr"><is><t>${escXml(COLS[c])}</t></is></c>`;
    }
    xml += '</row>';

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      xml += `<row r="${r + 2}">`;
      for (let c = 0; c < COLS.length; c++) {
        const val = row[COLS[c]] ?? '';
        if (typeof val === 'number') {
          xml += `<c r="${cellRef(c, r + 2)}"><v>${val}</v></c>`;
        } else {
          xml += `<c r="${cellRef(c, r + 2)}" t="inlineStr"><is><t>${escXml(val)}</t></is></c>`;
        }
      }
      xml += '</row>';
    }

    xml += '</sheetData></worksheet>';
    return xml;
  }

  async function zipEntry(filename, content) {
    const buf = Buffer.from(content, 'utf8');
    const compressed = await deflateRaw(buf);
    const crc = crc32(buf);
    const now = new Date();
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const nameBuf = Buffer.from(filename, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(buf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    return { local, compressed, crc, compressedSize: compressed.length, uncompressedSize: buf.length, dosDate, dosTime, nameBuf };
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/sheet"
xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Instagram Leads" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const entries = await Promise.all([
    zipEntry('[Content_Types].xml', contentTypes),
    zipEntry('_rels/.rels', rels),
    zipEntry('xl/workbook.xml', workbook),
    zipEntry('xl/_rels/workbook.xml.rels', workbookRels),
    zipEntry('xl/worksheets/sheet1.xml', buildSheet())
  ]);

  const parts = [];
  const offsets = [];
  let offset = 0;
  for (const e of entries) {
    offsets.push(offset);
    parts.push(e.local, e.compressed);
    offset += e.local.length + e.compressed.length;
  }

  const cdOffset = offset;
  const cdParts = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const cd = Buffer.alloc(46 + e.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(e.dosTime, 12);
    cd.writeUInt16LE(e.dosDate, 14);
    cd.writeUInt32LE(e.crc >>> 0, 16);
    cd.writeUInt32LE(e.compressedSize, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offsets[i], 42);
    e.nameBuf.copy(cd, 46);
    cdParts.push(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdOffset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...cdParts, eocd]);
}

async function listExcelFiles() {
  const files = await fs.readdir(DATA_EXCEL_DIR).catch(() => []);
  return files.filter(f => f.endsWith('.xlsx')).sort().map(f => path.join(DATA_EXCEL_DIR, f));
}

async function pruneExcelFiles() {
  const files = await listExcelFiles();
  while (files.length > MAX_EXCEL_FILES) {
    const oldest = files.shift();
    await fs.unlink(oldest).catch(() => {});
  }
}

function excelFileName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `instagram-leads-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${ms}.xlsx`;
}

async function saveRowsToExcel(rows) {
  const filePath = path.join(DATA_EXCEL_DIR, excelFileName());
  await fs.writeFile(filePath, await generateXlsx(rows));
  await pruneExcelFiles();
  return filePath;
}

function mergeRows(existing, incoming) {
  const map = new Map(existing.map(r => [String(r.username || '').toLowerCase(), r]));
  for (const row of incoming) {
    if (!row.username) continue;
    const key = String(row.username).toLowerCase();
    if (map.has(key)) {
      const ex = map.get(key);
      if (row.source_tags && !String(ex.source_tags || '').split(',').includes(row.source_tags)) {
        ex.source_tags = [ex.source_tags, row.source_tags].filter(Boolean).join(',');
      }
      for (const field of COLS) {
        if ((ex[field] === undefined || ex[field] === '') && row[field] !== undefined && row[field] !== '') {
          ex[field] = row[field];
        }
      }
    } else {
      map.set(key, { ...row });
    }
  }
  return [...map.values()];
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (req, res) => {
  try {
    res.json({ ok: true, port: PORT, connectivity: await checkInstagramConnectivity() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/data/latest', (req, res) => {
  const sinceDataVersion = parseInt(req.query.sinceDataVersion) || 0;
  if (sinceDataVersion >= runner.dataVersion) {
    return res.json({ ok: true, unchanged: true, dataVersion: runner.dataVersion, count: runner.rows.length });
  }
  res.json({ ok: true, rows: runner.rows, dataVersion: runner.dataVersion, count: runner.rows.length });
});

app.post('/api/data/save', async (req, res) => {
  try {
    runner.rows = mergeRows(runner.rows, req.body?.rows || []);
    runner.dataVersion++;
    const filePath = await saveRowsToExcel(runner.rows);
    addLog(`Saved ${runner.rows.length} rows to ${path.basename(filePath)}`);
    res.json({ ok: true, count: runner.rows.length, file: path.basename(filePath) });
  } catch (e) {
    res.json({ ok: false, error: e.message, hint: 'save failed' });
  }
});

app.post('/api/scrape', async (req, res) => {
  try {
    const options = await withDefaultCookieFile(req.body || {});
    const result = await scrapeInstagramTargets({
      ...options,
      onLog: addLog,
      onProgress: p => { runner.progress = p; }
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.json({ ok: false, error: e.message, hint: 'scrape failed' });
  }
});

app.get('/api/runner/status', (req, res) => {
  const sinceDataVersion = parseInt(req.query.sinceDataVersion) || 0;
  const sinceLogVersion = parseInt(req.query.sinceLogVersion) || 0;
  const newLogs = sinceLogVersion < runner.logVersion
    ? runner.logs.slice(Math.max(0, runner.logs.length - (runner.logVersion - sinceLogVersion)))
    : [];
  const newRows = sinceDataVersion < runner.dataVersion ? runner.rows : null;
  res.json({
    ok: true,
    running: runner.running,
    stopping: runner.stopping,
    currentTag: runner.currentTag,
    progress: runner.progress,
    rowCount: runner.rows.length,
    dataVersion: runner.dataVersion,
    logVersion: runner.logVersion,
    newLogs,
    newRows
  });
});

app.post('/api/runner/start', async (req, res) => {
  if (runner.running) return res.json({ ok: false, error: 'already running' });

  const options = await withDefaultCookieFile(req.body || {});
  runner.running = true;
  runner.stopping = false;
  runner.options = options;
  addLog('Instagram runner started');

  (async () => {
    const {
      tags = [],
      usernames = [],
      maxPostsPerTag = 30,
      batchSize = 12,
      batchDelayMin = 30,
      batchDelayMax = 75,
      activateHours = [8, 23],
      cookieStr = '',
      headless = true,
      humanMode = true,
      useBrowserFallback = true,
      runOnce = true
    } = options;

    let batchCount = 0;
    try {
      while (!runner.stopping) {
        const now = new Date();
        const chinaHour = (now.getUTCHours() + 8) % 24;
        if (!runOnce && (chinaHour < activateHours[0] || chinaHour >= activateHours[1])) {
          addLog(`Outside active hours (${chinaHour}:xx CST), waiting 30min...`);
          await sleep(30 * 60 * 1000);
          continue;
        }

        const result = await scrapeInstagramTargets({
          tags,
          usernames,
          maxPostsPerTag: humanMode ? randInt(Math.max(3, batchSize - 5), batchSize + 5) : maxPostsPerTag,
          cookieStr,
          headless,
          useBrowserFallback,
          onLog: addLog,
          onProgress: p => {
            runner.currentTag = p.tag;
            runner.progress = p;
          }
        });

        if (result.videos?.length) {
          runner.rows = mergeRows(runner.rows, result.videos);
          runner.dataVersion++;
          for (const row of runner.rows) {
            if (row.username) runner.seenUsernames.add(row.username);
          }
          await saveRowsToExcel(runner.rows).catch(e => addLog(`Save error: ${e.message}`));
          addLog(`Batch #${batchCount + 1} done: +${result.videos.length} rows, total=${runner.rows.length}`);
        } else {
          addLog(`Batch #${batchCount + 1} done: no rows`);
        }

        batchCount++;
        if (runOnce || runner.stopping) break;
        const delayMin = humanMode ? randInt(batchDelayMin, batchDelayMax) : batchDelayMin;
        addLog(`Next batch in ${delayMin}min`);
        await sleep(delayMin * 60 * 1000);
      }
    } catch (e) {
      addLog(`Runner error: ${e.message}`);
    } finally {
      runner.running = false;
      runner.stopping = false;
      runner.currentTag = '';
      runner.progress = null;
      addLog('Instagram runner stopped');
    }
  })();

  res.json({ ok: true, message: 'runner started' });
});

app.post('/api/runner/update', (req, res) => {
  Object.assign(runner.options, req.body || {});
  addLog('Runner options updated');
  res.json({ ok: true });
});

app.post('/api/runner/stop', (req, res) => {
  runner.stopping = true;
  addLog('Stop requested');
  res.json({ ok: true });
});

app.post('/api/runner/logs/clear', (req, res) => {
  runner.logs = [];
  runner.logVersion++;
  res.json({ ok: true });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randInt(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

app.listen(PORT, () => {
  console.log('\nInstagram Influencer Scraper is running:');
  console.log(`http://localhost:${PORT}`);
  console.log('\nFor tag search, install Playwright Chromium and provide Instagram cookies if needed.\n');
});
