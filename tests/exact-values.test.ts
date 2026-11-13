import { describe, expect, it } from 'vitest';
import type { SplitBlockInput, SplitCost } from 'pxpipe-proxy';
import {
  createExactHook,
  findExactCandidates,
  memoryStore,
  splitInterleave,
  type ExactForm,
  type ExactSelection,
  type ExactSelector,
} from '../src/exact-values.js';

const selectValues = (values: string[]): ExactSelector => async (_text, candidates) =>
  new Set(candidates.flatMap((candidate, index) => (values.includes(candidate.value) ? [index] : [])));

const cost: SplitCost = { imageTokens: (piece) => piece.length / 8, textTokens: (piece) => piece.length / 4 };

const input = (text: string, overrides: Partial<SplitBlockInput> = {}): SplitBlockInput => ({
  site: 'tool_result',
  text,
  protectedSpans: [],
  maxImageSegments: 10,
  cost,
  ...overrides,
});

describe('exact-value candidates', () => {
  it('keeps identifier-like tokens without digits, skips plain prose and protected spans', () => {
    const text = '<user t="4">\nRead src/core/x.ts then call fooBarBaz with deadbeef and MAX_RETRY now.\n</user>';
    const values = findExactCandidates(text, [{ start: 0, end: 12 }, { start: text.length - 7, end: text.length }])
      .map((candidate) => candidate.value);
    expect(values).toEqual(['src/core/x.ts', 'fooBarBaz', 'deadbeef', 'MAX_RETRY']);
  });
});

describe('interleave split', () => {
  const lines = ['alpha', 'beta', 'gamma', 'id 0123456789ab', 'delta', 'epsilon', 'zeta', 'eta', 'id fedcba987654', 'theta'];
  const text = lines.join('\n');
  const starts = findExactCandidates(text).map((candidate) => candidate.start);

  it('keeps selected lines as text, images the runs between them and covers the text in order', () => {
    const segments = splitInterleave(text, starts, 3);
    expect(segments.map((segment) => [segment.kind, text.slice(segment.start, segment.end)])).toEqual([
      ['image', 'alpha\nbeta\ngamma\n'],
      ['text', 'id 0123456789ab\n'],
      ['image', 'delta\nepsilon\nzeta\neta\n'],
      ['text', 'id fedcba987654\ntheta'],
    ]);
  });

  it('merges image runs shorter than the minimum into the text next to them', () => {
    const segments = splitInterleave(text, starts, 4);
    expect(segments.map((segment) => [segment.kind, text.slice(segment.start, segment.end)])).toEqual([
      ['text', 'alpha\nbeta\ngamma\nid 0123456789ab\n'],
      ['image', 'delta\nepsilon\nzeta\neta\n'],
      ['text', 'id fedcba987654\ntheta'],
    ]);
  });
});

describe('auto-jev hook', () => {
  const text = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'id 0123456789ab', 'eta'].join('\n');

  it('gives the same plan for the same text and decisions, and text when imaging saves nothing', async () => {
    const hook = createExactHook({ jev: selectValues(['0123456789ab']), minImageLines: 3 });
    const first = await hook(input(text));
    expect(await hook(input(text))).toEqual(first);
    expect(first.kind).toBe('segments');
    const expensive = await hook(input(text, { cost: { ...cost, imageTokens: (piece) => piece.length } }));
    expect(expensive.kind).toBe('text');
  });

  it('keeps a block as text while Jev is pending, then locks the first imaged form', async () => {
    const forms = memoryStore<ExactForm>();
    let answer: ExactSelection = 'pending';
    const jev: ExactSelector = async (_text, candidates) =>
      answer === 'pending' ? 'pending' : new Set([...answer].filter((index) => index < candidates.length));
    const hook = createExactHook({ jev, minImageLines: 3, forms });
    expect(await hook(input(text))).toMatchObject({ kind: 'text', reason: 'pending' });
    answer = new Set([0]);
    const locked = await hook(input(text));
    answer = new Set();
    const later = await createExactHook({ jev, minImageLines: 2, forms })(input(text));
    expect(later.kind).toBe('segments');
    if (locked.kind !== 'segments' || later.kind !== 'segments') throw new Error('expected segments');
    expect(later.segments).toEqual(locked.segments);
    expect(later.stats).toEqual({ exactLocked: 1, exactInterleave: 1 });
  });
});
