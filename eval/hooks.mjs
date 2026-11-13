// Eval-only hooks and label builders. NOT production code.
//
// interleave-all / interleave-jev: interleave every block with no cost choice.
// Labels (labels-regex, labels-all, labels-jev): NOT SAFE TO SEND TO ANTHROPIC.
// Every labels arm caused Opus reasoning_extraction refusals. They exist only so
// their builds (tokens, images) can be inspected offline.
import { findExactCandidates, fitImageCap } from '../dist/index.js';

export function interleaveHook({ jev, minImageLines }) {
  return async (input) => {
    const candidates = findExactCandidates(input.text, input.protectedSpans);
    const selection = candidates.length === 0 || !jev ? new Set(candidates.map((_candidate, index) => index)) : await jev(input.text, candidates);
    if (selection === 'pending') return { kind: 'text', reason: 'pending' };
    const starts = [...selection].map((index) => candidates[index].start).sort((left, right) => left - right);
    const { segments } = fitImageCap(input.text, starts, minImageLines, input.maxImageSegments);
    return {
      kind: 'segments',
      segments,
      stats: { exactCandidates: candidates.length, exactSelected: selection.size },
    };
  };
}

const RUN = /[A-Za-z0-9_./:@+#~-]+/g;

/** The earlier digit-only rule, used by labels-regex. */
export function findDigitCandidates(text) {
  const out = [];
  for (const match of text.matchAll(RUN)) {
    const lead = /^[:.,;~#+-]+/.exec(match[0])?.[0].length ?? 0;
    const value = match[0].slice(lead).replace(/[:.,;~#+-]+$/, '');
    const start = match.index + lead;
    const keep = value.length >= 3 && value.length <= 200 && /\d/.test(value)
      && (/[0-9a-fA-F]{6,}|\d{3,}|[./:@_-]/.test(value) || value.length >= 6);
    if (keep) out.push({ value, start, end: start + value.length });
  }
  return out;
}

const SIGILS = ['{#', '{%', '{^', '{!'];

/** Replace each selected position with a per-block label; one value gets one label. */
export function applyExactLabels(text, candidates, selected) {
  if (selected.size === 0) return { text, legend: '' };
  const sigil = SIGILS.find((candidate) => !text.includes(candidate)) ?? SIGILS[0];
  const labels = new Map();
  const parts = [];
  let cursor = 0;
  candidates.forEach((candidate, index) => {
    if (!selected.has(index) || candidate.start < cursor) return;
    let label = labels.get(candidate.value);
    if (label === undefined) {
      label = `${sigil}${labels.size + 1}}`;
      labels.set(candidate.value, label);
    }
    parts.push(text.slice(cursor, candidate.start), label);
    cursor = candidate.end;
  });
  parts.push(text.slice(cursor));
  const entries = [...labels].map(([value, label]) => `${label}=${value}`).join(' ');
  return {
    text: parts.join(''),
    legend:
      `[Exact values for the image above: each ${sigil}N} label in the image stands for the value given here. ` +
      'Find the label in the image, then quote the value from this list character for character. ' +
      `Never quote a label as a value. Legend: ${entries}]`,
  };
}
