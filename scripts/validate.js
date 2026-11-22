#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function readJson(relPath) {
  const fullPath = path.join(ROOT, relPath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    fail(`Invalid JSON in ${relPath}: ${err.message}`);
  }
}

function assertFileExists(relPath) {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing referenced file: ${relPath}`);
  }
}

// 1. Validate manifest.json & referenced assets
const manifest = readJson('manifest.json');
if (manifest.manifest_version !== 3) {
  fail(`Expected manifest_version 3, got ${manifest.manifest_version}`);
}
if (!manifest.version || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version)) {
  fail(`Invalid manifest version: ${manifest.version}`);
}
if (manifest.background?.service_worker) {
  assertFileExists(manifest.background.service_worker);
}
if (manifest.action?.default_popup) {
  assertFileExists(manifest.action.default_popup);
}
for (const iconPath of Object.values(manifest.icons || {})) {
  assertFileExists(iconPath);
}
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) {
    assertFileExists(f);
  }
}
console.log(`OK: manifest.json (v${manifest.version}) and all referenced files exist.`);

// 2. JS syntax check
const jsFiles = ['background.js', 'content.js', 'popup.js'];
for (const file of jsFiles) {
  execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'inherit' });
}
console.log(`OK: JS syntax valid (${jsFiles.join(', ')}).`);

// 3. Validate _locales parity, placeholders, and key usage
const localesDir = path.join(ROOT, '_locales');
const locales = fs
  .readdirSync(localesDir)
  .filter((name) => fs.statSync(path.join(localesDir, name)).isDirectory())
  .sort();

if (!locales.includes(manifest.default_locale)) {
  fail(`default_locale "${manifest.default_locale}" missing in _locales/`);
}

const localeMaps = {};
for (const loc of locales) {
  localeMaps[loc] = readJson(path.join('_locales', loc, 'messages.json'));
}

const baseLocale = manifest.default_locale;
const baseKeys = Object.keys(localeMaps[baseLocale]).sort();

for (const loc of locales) {
  const map = localeMaps[loc];
  const keys = Object.keys(map).sort();
  const missing = baseKeys.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !baseKeys.includes(k));
  if (missing.length || extra.length) {
    fail(`Locale "${loc}" key mismatch: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
  }

  for (const key of baseKeys) {
    const entry = map[key];
    if (!entry || typeof entry.message !== 'string' || !entry.message.trim()) {
      fail(`Empty message in "${loc}" for key "${key}"`);
    }
    const basePh = Object.keys(localeMaps[baseLocale][key].placeholders || {}).sort().join(',');
    const locPh = Object.keys(entry.placeholders || {}).sort().join(',');
    if (basePh !== locPh) {
      fail(`Placeholder mismatch in "${loc}" for key "${key}": expected [${basePh}], got [${locPh}]`);
    }
  }

  // Enforce Chrome Web Store hard limits on manifest name (<= 75) & description (<= 132)
  const nameLen = map.extName.message.length;
  const descLen = map.extDescription.message.length;
  if (nameLen > 75) {
    fail(`Locale "${loc}" extName exceeds 75 chars (${nameLen})`);
  }
  if (descLen > 132) {
    fail(`Locale "${loc}" extDescription exceeds 132 chars (${descLen})`);
  }
}

const usedKeys = new Set();
const manifestRaw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
for (const m of manifestRaw.matchAll(/__MSG_([a-zA-Z0-9_]+)__/g)) {
  usedKeys.add(m[1]);
}
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
for (const m of popupHtml.matchAll(/data-i18n(?:-(?:placeholder|title))?="([a-zA-Z0-9_]+)"/g)) {
  usedKeys.add(m[1]);
}
for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
    usedKeys.add(m[1]);
  }
}

const missingUsed = [...usedKeys].filter((k) => !localeMaps[baseLocale][k]);
const unusedKeys = baseKeys.filter((k) => !usedKeys.has(k));
if (missingUsed.length > 0) {
  fail(`Missing i18n keys referenced in code: ${missingUsed.join(', ')}`);
}
if (unusedKeys.length > 0) {
  fail(`Unused i18n keys in _locales/${baseLocale}/messages.json: ${unusedKeys.join(', ')}`);
}
console.log(`OK: i18n validated (${locales.length} locales x ${baseKeys.length} keys, 0 missing, 0 unused).`);

// 4. Unit tests for ICS & CSV date/preview parsers in content.js
const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dateParserMatch = contentSrc.match(
  /function parseIcsDateValue[\s\S]*?(?=\n  async function extractEarliestEventDateFromFile)/
);
const previewParserMatch = contentSrc.match(
  /function unescapeIcsText[\s\S]*?(?=\n  async function parseEventsPreviewFromFiles)/
);
if (!dateParserMatch || !previewParserMatch) {
  fail('Could not extract parser functions from content.js for testing.');
}

const t = (_k, _s, fb) => fb || 'All day';
const { parseIcsEventDates, parseCsvEventDates, parseEventsPreviewFromText } = new Function(
  't',
  `${dateParserMatch[0]}\n${previewParserMatch[0]}\nreturn { parseIcsEventDates, parseCsvEventDates, parseEventsPreviewFromText };`
)(t);

const sampleIcs = [
  'BEGIN:VCALENDAR',
  'BEGIN:VTIMEZONE',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700308T020000',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'SUMMARY:Later Event',
  'DTSTART;TZID=America/Los_Angeles:20270122T140000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Lab\\, Session 1',
  'DTSTART:20270118T093000',
  'LOCATION:Room 101',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

const icsDates = parseIcsEventDates(sampleIcs).sort((a, b) => a.sortKey - b.sortKey);
if (icsDates.length !== 2 || icsDates[0].year !== 2027 || icsDates[0].month !== 1 || icsDates[0].day !== 18) {
  fail(`ICS date parser failed: ${JSON.stringify(icsDates)}`);
}

const allDayDates = parseIcsEventDates('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261205\nEND:VEVENT');
if (allDayDates.length !== 1 || allDayDates[0].year !== 2026 || allDayDates[0].month !== 12 || allDayDates[0].day !== 5) {
  fail(`All-day ICS parser failed: ${JSON.stringify(allDayDates)}`);
}

const csvDates = parseCsvEventDates('Subject,Start Date,Start Time\nDemo,01/18/2027,10:00 AM');
if (csvDates.length !== 1 || csvDates[0].year !== 2027 || csvDates[0].month !== 1 || csvDates[0].day !== 18) {
  fail(`CSV date parser failed: ${JSON.stringify(csvDates)}`);
}

const preview = parseEventsPreviewFromText(sampleIcs, 'lab.ics');
if (preview.length !== 2 || preview[1].title !== 'Lab, Session 1' || preview[1].location !== 'Room 101') {
  fail(`ICS preview parser failed: ${JSON.stringify(preview)}`);
}
console.log('OK: ICS & CSV parser unit tests passed.');
