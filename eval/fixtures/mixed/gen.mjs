// Mixed-density fixtures for the exact-values auto rule.
//
//   pnpm run build && node eval/fixtures/mixed/gen.mjs
//
// Six transcripts of about 170 lines. A share of the lines equal to the target
// density are data lines (log dumps and file tables, every line holds ids,
// hashes, paths and numbers); the rest are prose lines with no exact-value
// candidates. Table paths have no digits, as in real transcripts. Each fixture has exact probes (hex, numeric, path, hash) and gist
// probes (decision, name, negation). Same seed, same bytes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExactCandidates } from '../../../dist/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = 7;
const TOTAL_LINES = 170;
const DENSITIES = [0, 10, 25, 50, 75, 100];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);
const pick = (list) => list[Math.floor(random() * list.length)];
const int = (low, high) => low + Math.floor(random() * (high - low + 1));
const hex = (length) => Array.from({ length }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('');

const SUBJECTS = ['the queue handler', 'the retry logic', 'the parser', 'the cache layer', 'the test suite', 'the build step', 'the router', 'the session store', 'the config loader', 'the worker pool', 'the logger', 'the scheduler'];
const VERBS = ['looks fine', 'needs a small change', 'still fails on one case', 'passes now', 'is slower than before', 'reads the wrong field', 'handles the empty case', 'skips the last item', 'was refactored', 'now returns early'];
const TAILS = ['after the last change', 'when the input is empty', 'on the second run', 'in the nightly job', 'with the new defaults', 'under load', 'after a restart', 'in the staging setup', 'for large inputs', 'when the flag is set'];
const OPENERS = ['I checked', 'I read', 'Next I looked at', 'I traced', 'We agreed that', 'It seems', 'I confirmed', 'Please note'];
const ROUTES = ['users', 'orders', 'items', 'search', 'billing', 'events', 'reports', 'tokens'];
const DIRS = ['core', 'batcher', 'cursor', 'render', 'proxy', 'store', 'gate', 'trace'];
const SUBDIRS = ['io', 'util', 'model', 'http', 'cache', 'sync'];
const FILES = ['index', 'worker', 'queue', 'reader', 'writer', 'parser', 'state', 'client'];
const PACKAGES = ['zustand', 'mobx', 'xstate', 'jotai', 'valtio', 'effector'];
const PEOPLE = ['Priya Natarajan', 'Tobias Okafor', 'Mei Lindqvist', 'Rafael Moreau', 'Ines Kowalski', 'Daniel Achebe'];
const FEATURES = ['cache warmer', 'request tracer', 'batch writer', 'audit hook', 'slow query log', 'retry budget'];

function proseLine() {
  const role = random() < 0.5 ? '[assistant]' : '[user]';
  return `${role} ${pick(OPENERS)} ${pick(SUBJECTS)} ${pick(VERBS)} ${pick(TAILS)}.`;
}

function logDump(count, used) {
  const lines = [];
  const records = [];
  const base = Date.UTC(2026, 2, int(1, 28), int(0, 23), int(0, 59), 0);
  for (let index = 0; index < count; index++) {
    let duration;
    do duration = int(1000, 9999); while (used.durations.has(duration));
    used.durations.add(duration);
    const request = hex(12);
    const stamp = new Date(base + index * int(200, 4000)).toISOString();
    lines.push(`${stamp} INFO worker=w${int(1, 9)} req=${request} dur_ms=${duration} path=/api/v2/${pick(ROUTES)} status=200`);
    records.push({ request, duration });
  }
  return { lines, records, kind: 'log' };
}

function fileTable(count, used) {
  const lines = ['| commit | path | digest | size |'];
  const records = [];
  for (let index = 0; index < count - 1; index++) {
    let file;
    do file = `src/${pick(DIRS)}/${pick(SUBDIRS)}/${pick(FILES)}.ts`; while (used.paths.has(file));
    used.paths.add(file);
    const commit = hex(8);
    const digest = hex(16);
    lines.push(`| ${commit} | ${file} | sha256:${digest} | ${int(200, 99999)} bytes |`);
    records.push({ commit, file, digest });
  }
  return { lines, records, kind: 'table' };
}

function build(density) {
  const id = `m${String(density).padStart(3, '0')}`;
  const used = { durations: new Set(), paths: new Set() };
  const gist = {
    decision: pick(PACKAGES),
    name: pick(PEOPLE),
    feature: pick(FEATURES),
  };
  const gistLines = [
    `[user] We picked the ${gist.decision} package for client state.`,
    `[assistant] ${gist.name} will review the change before it ships.`,
    `[user] We did not turn on the ${gist.feature} in production.`,
  ];
  const dataTotal = Math.min(TOTAL_LINES - gistLines.length, Math.round((density / 100) * TOTAL_LINES));
  const dumpCount = dataTotal === 0 ? 0 : dataTotal < 24 ? 2 : 3;
  const sizes = Array.from({ length: dumpCount }, (_unused, index) =>
    Math.floor(dataTotal / dumpCount) + (index < dataTotal % dumpCount ? 1 : 0));
  const dumps = sizes.map((size, index) => (index % 2 === 0 ? logDump(size, used) : fileTable(size, used)));
  const proseTotal = TOTAL_LINES - dataTotal - gistLines.length;
  const fillers = Array.from({ length: proseTotal }, proseLine);
  const units = [...fillers.map((line) => ({ lines: [line] })), ...gistLines.map((line) => ({ lines: [line] }))];
  for (const dump of dumps) units.splice(int(0, units.length), 0, { lines: dump.lines });
  const gistUnits = units.filter((unit) => gistLines.includes(unit.lines[0]));
  if (gistUnits.length !== 3) throw new Error(`${id}: gist line lost`);
  const lines = ['=== earlier coding session transcript ===', ...units.flatMap((unit) => unit.lines)];
  const text = lines.join('\n') + '\n';
  for (const line of lines) {
    const isData = dumps.some((dump) => dump.lines.includes(line));
    if (!isData && findExactCandidates(line).length > 0) throw new Error(`${id}: prose line has candidates: ${line}`);
  }

  const probes = [];
  const add = (type, q, gold) => {
    if (!text.includes(gold) && !['negation'].includes(type)) throw new Error(`${id}: gold not in text: ${gold}`);
    probes.push({ id: `${id}-${type}`, doc: id, type, q, gold });
  };
  const logs = dumps.filter((dump) => dump.kind === 'log').flatMap((dump) => dump.records);
  const rows = dumps.filter((dump) => dump.kind === 'table').flatMap((dump) => dump.records);
  if (logs.length > 0) {
    const hexProbe = pick(logs);
    add('hex', `Find the log line whose dur_ms is exactly ${hexProbe.duration} and report ONLY its req value (12 hex characters).`, hexProbe.request);
    let numericProbe;
    do numericProbe = pick(logs); while (logs.length > 1 && numericProbe === hexProbe);
    add('numeric', `Find the log line whose req is ${numericProbe.request} and report ONLY its dur_ms number.`, String(numericProbe.duration));
  }
  if (rows.length > 0) {
    const pathProbe = pick(rows);
    add('path', `In the file table, which path is in the row with commit ${pathProbe.commit}? Report ONLY the path.`, pathProbe.file);
    let hashProbe;
    do hashProbe = pick(rows); while (rows.length > 1 && hashProbe === pathProbe);
    add('hash', `In the file table, what is the sha256 digest in the row for ${hashProbe.file}? Report ONLY the 16 hex characters after sha256:`, hashProbe.digest);
  }
  add('decision', 'Which package did the team pick for client state? Reply with only the package name.', gist.decision);
  add('name', 'Who will review the change before it ships? Reply with only the full name.', gist.name);
  add('negation', `Is the ${gist.feature} turned on in production? Reply ON or OFF.`, 'OFF');

  return {
    id,
    text,
    probes,
    manifest: {
      id,
      density,
      lines: lines.length,
      dataLines: dataTotal,
      dataShare: Number((dataTotal / lines.length).toFixed(3)),
      dumps: dumps.map((dump) => ({ kind: dump.kind, lines: dump.lines.length })),
      chars: text.length,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    },
  };
}

const fixtures = DENSITIES.map(build);
for (const fixture of fixtures) fs.writeFileSync(path.join(HERE, `${fixture.id}.txt`), fixture.text);
fs.writeFileSync(path.join(HERE, 'probes.json'), JSON.stringify(fixtures.flatMap((fixture) => fixture.probes), null, 1) + '\n');
fs.writeFileSync(path.join(HERE, 'provenance.json'), JSON.stringify({
  generatedBy: 'eval/fixtures/mixed/gen.mjs',
  generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  seed: SEED,
  totalLines: TOTAL_LINES,
  note: 'Deterministic: the same seed and generator give the same bytes. Prose lines have no exact-value candidates.',
  fixtures: fixtures.map((fixture) => fixture.manifest),
}, null, 1) + '\n');
console.log(fixtures.map((fixture) => `${fixture.id} lines=${fixture.manifest.lines} data=${fixture.manifest.dataLines} chars=${fixture.manifest.chars} probes=${fixture.probes.length}`).join('\n'));
