// Offline calibration of the auto-jev rule. No model calls.
//
//   node eval/sweep.mjs [suite=mixed]
//
// For each doc, build.json holds the production estimate of the auto-jev build
// (text tokens and interleave-jev-n6 tokens, from the transform's cost model).
// Auto images a block with interleave when the estimated saving is at least the
// threshold, else the block stays text. For each threshold, the measured answers
// and input tokens of the chosen arm come from results.jsonl. A threshold is
// safe when every chosen arm was measured on every probe with no refusal and
// the correct count is not below always-interleave. labels-regex is shown for
// reference only: it is not an auto arm after its refusal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suite = process.argv[2] ?? 'mixed';
const dir = path.join(HERE, 'out', suite);
const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
const rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const docs = [...new Set(rows.map((row) => row.doc))].sort();
const reps = [...new Set(rows.map((row) => row.rep))].sort();
const probesPerDoc = (doc) => new Set(rows.filter((row) => row.doc === doc).map((row) => row.probe)).size * reps.length;

function measured(arm, doc) {
  const own = rows.filter((row) => row.arm === arm && row.doc === doc);
  return {
    calls: own.length,
    correct: own.filter((row) => row.correct).length,
    refused: own.filter((row) => row.status !== 'OK').length,
    tokens: own.reduce((sum, row) => sum + row.inputTokens - row.overheadTokens, 0) / Math.max(1, own.length),
  };
}

const estimate = (doc) => {
  const stats = build.docs[`auto-jev/${doc}`]?.stats ?? {};
  return {
    textTokens: stats.exactTextTokens ?? 0,
    interleaveTokens: stats.exactInterleaveTokens ?? 0,
    exactLineShare: stats.exactLines ? stats.exactSelectedLines / stats.exactLines : 0,
  };
};
const estimatedSaving = (doc) => {
  const auto = estimate(doc);
  return auto.textTokens > 0 ? 1 - auto.interleaveTokens / auto.textTokens : 0;
};

function evaluate(choose) {
  const total = { correct: 0, calls: 0, missing: 0, refused: 0, tokens: 0, textTokens: 0, choices: [] };
  for (const doc of docs) {
    const arm = choose(doc);
    const result = measured(arm, doc);
    total.missing += probesPerDoc(doc) - result.calls;
    total.refused += result.refused;
    total.correct += result.correct;
    total.calls += result.calls;
    total.tokens += result.tokens;
    total.textTokens += measured('text', doc).tokens;
    total.choices.push(`${doc}:${arm === 'text' ? 'T' : arm === 'labels-regex' ? 'L' : 'I'}`);
  }
  return { ...total, savings: 1 - total.tokens / total.textTokens, choices: total.choices.join(' ') };
}

console.log(`suite ${suite}, docs ${docs.length}, reps ${reps.join(',')}`);
console.log('doc  | line share | est text | est interleave | est saving | measured tok T/I/L | measured saving I | correct T/I/L | images I | Jev $');
for (const doc of docs) {
  const auto = estimate(doc);
  const [text, interleave, labels] = ['text', 'interleave-jev-n6', 'labels-regex'].map((arm) => measured(arm, doc));
  console.log(
    `${doc} | ${auto.exactLineShare.toFixed(2).padStart(10)} | ${auto.textTokens.toFixed(0).padStart(8)} | ${auto.interleaveTokens.toFixed(0).padStart(14)} | ` +
    `${(100 * estimatedSaving(doc)).toFixed(1).padStart(9)}% | ${[text, interleave, labels].map((value) => value.calls ? value.tokens.toFixed(0) : '-').join('/').padStart(18)} | ` +
    `${(100 * (1 - interleave.tokens / text.tokens)).toFixed(1).padStart(16)}% | ` +
    `${[text, interleave, labels].map((value) => `${value.correct}/${value.calls}${value.refused ? ` (${value.refused} refused)` : ''}`).join(' ')} | ` +
    `${build.docs[`interleave-jev-n6/${doc}`]?.images ?? '-'} | ${(build.jev[doc]?.costUsd ?? 0).toFixed(4)}`,
  );
}

const baseline = evaluate(() => 'interleave-jev-n6');
console.log('\nfixed arms:');
for (const arm of ['text', 'interleave-jev-n6', 'labels-regex']) {
  const result = evaluate(() => arm);
  console.log(`  ${arm.padEnd(18)} correct ${result.correct}/${result.calls}  refused ${result.refused}  unmeasured ${result.missing}  savings ${(100 * result.savings).toFixed(1)}%`);
}

const cuts = docs.map(estimatedSaving);
const thresholds = [...new Set([0, ...cuts, ...cuts.map((cut) => cut + 1e-6), 1])].filter((value) => value > 0).sort((a, b) => a - b);
console.log('\nthreshold sweep (interleave when estimated saving >= threshold, else text):');
let best = null;
for (const threshold of [Number.MIN_VALUE, ...thresholds]) {
  const result = evaluate((doc) => (estimatedSaving(doc) >= threshold ? 'interleave-jev-n6' : 'text'));
  const safe = result.missing === 0 && result.refused === 0 && result.correct >= baseline.correct;
  const verdict = result.refused > 0 ? 'REFUSED' : result.missing > 0 ? 'UNMEASURED' : safe ? 'ok' : 'LOSS';
  const label = threshold === Number.MIN_VALUE ? '>0' : `${(100 * threshold).toFixed(2)}%`;
  console.log(`  threshold ${label.padStart(7)}  correct ${result.correct}/${result.calls}  savings ${(100 * result.savings).toFixed(1).padStart(5)}%  ${verdict.padEnd(10)}  ${result.choices}`);
  if (safe && (!best || result.savings > best.savings + 1e-9)) best = { threshold, label, ...result };
}
console.log(best
  ? `\nbest threshold with no accuracy loss vs always-interleave: ${best.label} (savings ${(100 * best.savings).toFixed(1)}%, correct ${best.correct}/${best.calls})`
  : '\nno threshold keeps accuracy');
