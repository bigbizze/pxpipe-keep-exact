// Exact-values A/B: the same fixtures through every exact-value mode, read by one model.
//
//   pnpm run build && node eval/run.mjs --suite verbatim|gist|mixed --arms a,b [--reps 1] [--par 2] [--limit N]
//
// Safety: only arms in ANTHROPIC_SAFE_ARMS may be sent (labels-all and
// labels-jev caused Opus refusals). The run refuses to start when
// ANTHROPIC_BASE_URL is set or another eval is running, and it stops at the
// first refused or failed call without a retry.
//
// Each source text goes through the production transform as one tool_result.
// The resulting content parts (text, images, legend) are sent to the model with
// `claude -p --input-format stream-json`, so the billed input tokens come from the
// API, not from an estimate. The proxy is bypassed (ANTHROPIC_BASE_URL unset).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_SAFE_ARMS, ARMS, MODEL, buildParts, makeJev } from './arms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const SUITE = arg('suite', 'verbatim');
const ARM_NAMES = arg('arms', ANTHROPIC_SAFE_ARMS.join(',')).split(',');
const BUILD_ONLY = ARM_NAMES.filter((arm) => ARMS[arm]?.offline);
const SEND_ARMS = ARM_NAMES.filter((arm) => !ARMS[arm]?.offline);
const REPS = Number(arg('reps', '1'));
const PAR = Number(arg('par', '2'));
for (const arm of ARM_NAMES) {
  if (!ARMS[arm]) throw new Error(`unknown arm ${arm}`);
  if (!ARMS[arm].anthropicSafe) {
    console.error(`refused: arm ${arm} is not safe to send to Anthropic. Allowed: ${ANTHROPIC_SAFE_ARMS.join(', ')}`);
    process.exit(2);
  }
}
if (process.env.ANTHROPIC_BASE_URL) {
  console.error('refused: ANTHROPIC_BASE_URL is set; unset it so no proxy sits between the eval and Anthropic');
  process.exit(2);
}
const others = spawnSync('pgrep', ['-af', '^(node \\S*eval/run\\.mjs|claude -p)'], { encoding: 'utf8' }).stdout
  .split('\n').filter((line) => line && !line.startsWith(`${process.pid} `));
if (others.length > 0) {
  console.error(`refused: another eval is running:\n${others.join('\n')}`);
  process.exit(2);
}
const LIMIT = Number(arg('limit', '0'));
const OUT = path.join(HERE, 'out', SUITE);
fs.mkdirSync(OUT, { recursive: true });
const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;

function loadSuite() {
  if (SUITE === 'mixed') {
    const dir = path.join(FIXTURES, 'mixed');
    const probes = JSON.parse(fs.readFileSync(path.join(dir, 'probes.json'), 'utf8')).map((probe) => ({
      ...probe,
      q: `${probe.q}\nIf the transcript does not contain the answer, reply exactly UNKNOWN. Reply with only the answer, nothing else.`,
    }));
    const docs = [...new Set(probes.map((probe) => probe.doc))].map((id) => ({
      id,
      text: fs.readFileSync(path.join(dir, `${id}.txt`), 'utf8'),
    }));
    return { docs, probes };
  }
  if (SUITE === 'verbatim') {
    const dir = path.join(FIXTURES, 'verbatim-15');
    const golds = JSON.parse(fs.readFileSync(path.join(dir, 'golds.json'), 'utf8'));
    const docs = [...new Set(golds.map((gold) => gold.page))].map((page) => ({
      id: `page${page}`,
      text: fs.readFileSync(path.join(dir, `page${page}.txt`), 'utf8'),
    }));
    const probes = golds.map((gold, index) => ({
      id: `v${String(index).padStart(2, '0')}`,
      doc: `page${gold.page}`,
      type: 'hex',
      gold: gold.gold,
      q: `Find the JSON line whose dur_ms is exactly ${gold.dur} and report ONLY its "id" field value (12 hex chars), nothing else.`,
    }));
    return { docs, probes };
  }
  const work = path.join(FIXTURES, 'gist-recall');
  const probes = JSON.parse(fs.readFileSync(path.join(work, 'probes.json'), 'utf8')).map((probe, index) => ({
    id: `g${String(index).padStart(2, '0')}`,
    doc: `s${probe.session}`,
    type: probe.type,
    gold: probe.gold,
    q: `${probe.q}\nIf the transcript does not contain the answer, reply exactly UNKNOWN. Reply with only the answer, nothing else.`,
  }));
  const docs = [...new Set(probes.map((probe) => probe.doc))].map((id) => ({
    id,
    text: fs.readFileSync(path.join(work, `${id}.txt`), 'utf8'),
  }));
  return { docs, probes };
}

const HEX = /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/g;
const norm = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const lastToken = (answer) => answer.trim().split(/[\s`'"]+/).filter(Boolean).pop() ?? '';
function grade(probe, answer) {
  if (SUITE === 'mixed') {
    if (probe.type === 'hex' || probe.type === 'hash' || probe.type === 'path') return lastToken(answer).replace(/^sha256:/, '').replace(/[.,]$/, '') === probe.gold;
    if (probe.type === 'numeric') return (answer.match(/\d+/g) ?? []).includes(probe.gold);
    if (probe.type === 'negation') return /\boff\b/i.test(answer) && !/\bon\b/i.test(answer.replace(/\boff\b/gi, ''));
    return norm(answer).includes(norm(probe.gold));
  }
  if (probe.type === 'hex') {
    const found = answer.match(HEX) ?? [];
    return found.length > 0 && found[found.length - 1] === probe.gold;
  }
  const a = norm(answer);
  const g = norm(probe.gold);
  if (probe.type === 'unanswerable') return a === 'unknown';
  if (probe.type === 'numeric') return (a.match(/\d+/g) ?? []).includes(g);
  if (probe.type === 'negation') return a.includes('off') && !a.includes('enabled');
  return a.includes(g);
}

const INTRO = SUITE === 'verbatim'
  ? 'The tool result below is the file data.txt. Parts of it may be rendered as images; read all parts in order.'
  : 'The tool result below is an earlier coding session transcript. Parts of it may be rendered as images; read all parts in order.';

function ask(parts, question) {
  const message = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: INTRO }, ...parts, { type: 'text', text: `Question: ${question}` }] },
  };
  const env = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', '--model', MODEL, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', 'Answer the question from the provided content only.',
    ], { env });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } });
      const result = lines.reverse().find((line) => line?.type === 'result');
      if (!result) return resolve({ status: 'ERROR', answer: '', inputTokens: 0, costUsd: 0 });
      const usage = result.usage ?? {};
      const refused = /safeguards flagged|API Error|reasoning_extraction/i.test(result.result ?? '');
      resolve({
        status: result.is_error || result.subtype !== 'success' ? 'ERROR' : refused ? 'REFUSED' : 'OK',
        stopReason: result.stop_reason ?? null,
        answer: result.result ?? '',
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        costUsd: result.total_cost_usd ?? 0,
      });
    });
    child.stdin.end(JSON.stringify(message) + '\n');
  });
}

const { docs, probes: allProbes } = loadSuite();
const probes = LIMIT ? allProbes.slice(0, LIMIT) : allProbes;

const decisionsFile = path.join(OUT, 'jev-decisions.json');
const decisions = fs.existsSync(decisionsFile) ? JSON.parse(fs.readFileSync(decisionsFile, 'utf8')) : {};
const decisionStore = { get: (key) => decisions[key], set: (key, value) => { decisions[key] = value; } };
const built = {};
const jevPerDoc = {};
for (const doc of docs) {
  const jev = makeJev(apiKey, decisionStore);
  for (const arm of [...SEND_ARMS, ...BUILD_ONLY]) {
    const result = await buildParts(doc.text, arm, jev.selector);
    const sideChars = result.parts.filter((part) => part.type === 'text').reduce((sum, part) => sum + part.text.length, 0);
    built[`${arm}/${doc.id}`] = {
      parts: result.parts,
      images: result.images,
      imageTokens: result.imageTokens,
      textChars: sideChars,
      candidates: result.stats.exactCandidates ?? 0,
      selected: result.stats.exactSelected ?? 0,
      stats: result.stats,
    };
  }
  jevPerDoc[doc.id] = { ...jev.stats };
}
fs.writeFileSync(decisionsFile, JSON.stringify(decisions));
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({
  docs: Object.fromEntries(Object.entries(built).map(([key, value]) => [key, { ...value, parts: undefined }])),
  jev: jevPerDoc,
}, null, 1));

if (SEND_ARMS.length === 0 || process.argv.includes('--build-only')) {
  console.log('build only, no model calls');
  process.exit(0);
}
const overhead = await ask([], 'Reply with OK.');
if (overhead.status !== 'OK') {
  console.error(`HARD STOP: the overhead call was not a normal answer: ${overhead.status} ${overhead.answer}`);
  process.exit(3);
}
console.log(`overhead input tokens (intro + question scaffold): ${overhead.inputTokens}`);

const resultsFile = path.join(OUT, 'results.jsonl');
const done = new Set(
  fs.existsSync(resultsFile)
    ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const row = JSON.parse(line);
      return `${row.arm}/${row.probe}/${row.rep}`;
    })
    : [],
);
const jobs = [];
for (let rep = 0; rep < REPS; rep++) {
  for (const arm of SEND_ARMS) {
    for (const probe of probes) {
      if (!done.has(`${arm}/${probe.id}/${rep}`)) jobs.push({ arm, probe, rep });
    }
  }
}
console.log(`${jobs.length} calls, ${PAR} parallel`);
const stream = fs.createWriteStream(resultsFile, { flags: 'a' });
let next = 0;
let finished = 0;
let stopped = null;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < jobs.length && !stopped) {
    const job = jobs[next++];
    const build = built[`${job.arm}/${job.probe.doc}`];
    const reply = await ask(build.parts, job.probe.q);
    const row = {
      arm: job.arm, probe: job.probe.id, doc: job.probe.doc, type: job.probe.type, rep: job.rep,
      gold: job.probe.gold, answer: reply.answer.slice(0, 400), status: reply.status,
      correct: reply.status === 'OK' && grade(job.probe, reply.answer),
      inputTokens: reply.inputTokens, overheadTokens: overhead.inputTokens, costUsd: reply.costUsd,
      stopReason: reply.stopReason,
    };
    stream.write(JSON.stringify(row) + '\n');
    const abnormalStop = reply.stopReason !== null && reply.stopReason !== 'end_turn';
    if (reply.status !== 'OK' || abnormalStop) {
      stopped ??= row;
      console.error(`HARD STOP: arm=${row.arm} doc=${row.doc} probe=${row.probe} status=${row.status} stop_reason=${row.stopReason}\n${reply.answer}`);
    }
    finished++;
    if (finished % 10 === 0) console.log(`${finished}/${jobs.length}`);
  }
}));
stream.end();
if (stopped) {
  console.error(`stopped after ${finished} calls; no retry`);
  process.exit(3);
}
console.log('done');
