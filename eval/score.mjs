// node eval/score.mjs verbatim|gist|mixed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const suite = process.argv[2] ?? 'verbatim';
const dir = path.join(HERE, 'out', suite);
const build = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
const rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const arms = [...new Set(rows.map((row) => row.arm))];
const docs = [...new Set(rows.map((row) => row.doc))];
const textArm = rows.filter((row) => row.arm === 'text');
const textTokens = textArm.reduce((sum, row) => sum + row.inputTokens - row.overheadTokens, 0) / Math.max(1, textArm.length);
const jevCost = Object.values(build.jev).reduce((sum, stats) => sum + stats.costUsd, 0);
const jevLatency = Object.values(build.jev).map((stats) => stats.latencyMs);

console.log(`suite ${suite}, ${docs.length} docs, Jev total $${jevCost.toFixed(4)}, latency per doc ms: ${jevLatency.join(' ')}`);
console.log('arm                 | correct per rep        | mean   | errors | content tok/doc | vs text | images/doc | img tok/doc | text chars/doc | cand/sel per doc');
for (const arm of arms) {
  const own = rows.filter((row) => row.arm === arm);
  const reps = [...new Set(own.map((row) => row.rep))].sort();
  const perRep = reps.map((rep) => {
    const repRows = own.filter((row) => row.rep === rep);
    return `${repRows.filter((row) => row.correct).length}/${repRows.length}`;
  });
  const scored = suite === 'gist' ? own.filter((row) => row.type !== 'unanswerable') : own;
  const mean = scored.filter((row) => row.correct).length / Math.max(1, scored.length);
  const errors = own.filter((row) => row.status !== 'OK').length;
  const contentTokens = own.reduce((sum, row) => sum + row.inputTokens - row.overheadTokens, 0) / Math.max(1, own.length);
  const builds = docs.map((doc) => build.docs[`${arm}/${doc}`]).filter(Boolean);
  const avg = (key) => builds.reduce((sum, item) => sum + item[key], 0) / Math.max(1, builds.length);
  console.log(
    `${arm.padEnd(19)} | ${perRep.join(' ').padEnd(22)} | ${(100 * mean).toFixed(1).padStart(5)}% | ${String(errors).padStart(6)} | ` +
    `${contentTokens.toFixed(0).padStart(15)} | ${(100 * (1 - contentTokens / textTokens)).toFixed(0).padStart(6)}% | ` +
    `${avg('images').toFixed(1).padStart(10)} | ${avg('imageTokens').toFixed(0).padStart(11)} | ${avg('textChars').toFixed(0).padStart(14)} | ` +
    `${avg('candidates').toFixed(0)}/${avg('selected').toFixed(0)}`,
  );
}
if (suite === 'gist') {
  console.log('\nconfabulation on unanswerable (wrong / total):');
  for (const arm of arms) {
    const own = rows.filter((row) => row.arm === arm && row.type === 'unanswerable');
    console.log(`  ${arm.padEnd(19)} ${own.filter((row) => !row.correct).length}/${own.length}`);
  }
}
