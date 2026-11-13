/**
 * Exact values in imaged text.
 *
 * Weak vision readers (Opus 5.5, Sonnet 5.5) read the layout of a dense page
 * well but misread single glyphs inside opaque values. This module finds every
 * token that is not plain prose, asks a selector (Jev) which positions must stay
 * exact, and keeps the lines that hold them as text. The other lines are imaged,
 * in the original order. The only production mode is `auto-jev`: per block,
 * interleave when the estimate saves input tokens, else the block stays text.
 *
 * Prompt-cache rules: a form is a pure function of (text, stored Jev decisions,
 * options). With a form store, the first form of a block is stored and reused,
 * so a later Jev result or threshold change applies only to new blocks. While
 * Jev has not answered, the block stays text (reason `pending`) and nothing is
 * stored; the request is not delayed.
 */

import type { SplitBlock, SplitBlockInput, SplitBlockPlan, SplitCost, SplitSegment, SplitSpan } from 'pxpipe-proxy';

export interface ExactCandidate {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Selected candidate indices, or `pending` while the decisions are not stored yet. */
export type ExactSelection = ReadonlySet<number> | 'pending';

/** Returns the indices (into `candidates`) of the positions that must stay exact. */
export type ExactSelector = (text: string, candidates: readonly ExactCandidate[]) => Promise<ExactSelection>;

export interface KeyValueStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
}

export function memoryStore<T>(): KeyValueStore<T> {
  const map = new Map<string, T>();
  return { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) };
}

const RUN = /[A-Za-z0-9_./:@+#~-]+/g;
const LEAD_TRIM = /^[:.,;~#+-]+/;
const TAIL_TRIM = /[:.,;~#+-]+$/;
const MAX_LEN = 200;

function isPlainProse(token: string): boolean {
  return /^[A-Za-z][a-z]*$/.test(token) || /^[A-Z]+$/.test(token);
}

/** Identifier-like, path-like, hex-like, numeric or mixed-case: any token that is not a plain word. */
function isExactCandidate(token: string): boolean {
  if (token.length < 2 || token.length > MAX_LEN) return false;
  if (!/[A-Za-z0-9]/.test(token)) return false;
  if (isPlainProse(token)) return /^[0-9a-fA-F]{6,}$/.test(token);
  return true;
}

/** Tokenize and keep every token that is not plain prose and not inside a protected span. */
export function findExactCandidates(text: string, protectedSpans: readonly SplitSpan[] = []): ExactCandidate[] {
  const out: ExactCandidate[] = [];
  for (const match of text.matchAll(RUN)) {
    const lead = LEAD_TRIM.exec(match[0])?.[0].length ?? 0;
    const value = match[0].slice(lead).replace(TAIL_TRIM, '');
    const start = match.index + lead;
    const end = start + value.length;
    if (!isExactCandidate(value)) continue;
    if (protectedSpans.some((span) => start < span.end && end > span.start)) continue;
    out.push({ value, start, end });
  }
  return out;
}

/**
 * Split at line boundaries: a line that holds a selected position stays text,
 * runs of other lines become images. An image run shorter than `minImageLines`
 * lines stays text. Neighbours of one kind are merged, so the result
 * alternates text, image, text, ...
 */
export function splitInterleave(
  text: string,
  selectedStarts: readonly number[],
  minImageLines: number,
): SplitSegment[] {
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineEnd = (line: number) => (line + 1 < lineStarts.length ? lineStarts[line + 1]! : text.length);
  const exactLine = new Array<boolean>(lineStarts.length).fill(false);
  let line = 0;
  for (const start of [...selectedStarts].sort((left, right) => left - right)) {
    while (line + 1 < lineStarts.length && lineEnd(line) <= start) line++;
    exactLine[line] = true;
  }
  const segments: SplitSegment[] = [];
  let runFirst = 0;
  for (let current = 1; current <= lineStarts.length; current++) {
    if (current < lineStarts.length && exactLine[current] === exactLine[runFirst]) continue;
    const short = current - runFirst < minImageLines;
    const kind = exactLine[runFirst] || short ? 'text' : 'image';
    const start = lineStarts[runFirst]!;
    const end = lineEnd(current - 1);
    const previous = segments[segments.length - 1];
    if (previous && previous.kind === kind) segments[segments.length - 1] = { kind, start: previous.start, end };
    else segments.push({ kind, start, end });
    runFirst = current;
  }
  return segments;
}

/**
 * Raise the minimum image-run length until the split needs at most `maxImages`
 * image segments. Short runs merge into text first, so the cap costs the least
 * imaged text.
 */
export function fitImageCap(
  text: string,
  selectedStarts: readonly number[],
  minImageLines: number,
  maxImages: number,
): { segments: SplitSegment[]; minImageLines: number } {
  let lines = minImageLines;
  let segments = splitInterleave(text, selectedStarts, lines);
  while (segments.filter((segment) => segment.kind === 'image').length > Math.max(1, maxImages)) {
    lines = Math.max(lines + 1, Math.ceil(lines * 1.5));
    segments = splitInterleave(text, selectedStarts, lines);
  }
  return { segments, minImageLines: lines };
}

/**
 * The stored form of one block: kept as text, or interleaved with its selection
 * and the split length fitted to the image cap when the block was first imaged.
 */
export type ExactForm =
  | { readonly arm: 'text' }
  | { readonly arm: 'interleave'; readonly selectedStarts: readonly number[]; readonly minImageLines: number };

export interface AutoEstimate {
  readonly textTokens: number;
  readonly interleaveTokens: number;
}

/** Input-token estimate of the interleave split, priced like the path that renders the block. */
export function estimateInterleave(text: string, segments: readonly SplitSegment[], cost: SplitCost): AutoEstimate {
  const interleaveTokens = segments.reduce((sum, segment) => {
    const piece = text.slice(segment.start, segment.end);
    const asText = cost.textTokens(piece);
    return sum + (segment.kind === 'text' ? asText : Math.min(asText, cost.imageTokens(piece.replace(/\n$/, ''))));
  }, 0);
  return { textTokens: cost.textTokens(text), interleaveTokens };
}

/** Interleave when its estimate saves input tokens, else the block stays text. */
export function chooseArm(estimate: AutoEstimate): ExactForm['arm'] {
  return estimate.interleaveTokens < estimate.textTokens ? 'interleave' : 'text';
}

export const DEFAULT_MIN_IMAGE_LINES = 6;

export interface ExactHookOptions {
  readonly jev: ExactSelector;
  /** Image runs shorter than this many lines stay text. Default 6. */
  readonly minImageLines?: number;
  /** Form lock: the first form of each block, keyed by site and text. */
  readonly forms?: KeyValueStore<ExactForm>;
}

function countLines(text: string, sortedStarts: readonly number[]): number {
  const lines = new Set<number>();
  let line = 0;
  let newline = text.indexOf('\n');
  for (const start of sortedStarts) {
    while (newline !== -1 && newline < start) {
      line++;
      newline = text.indexOf('\n', newline + 1);
    }
    lines.add(line);
  }
  return lines.size;
}

async function formKey(site: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`auto-jev\u0000${site}\u0000${text}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function planFromForm(input: SplitBlockInput, form: ExactForm, stats: Record<string, number>): SplitBlockPlan {
  if (form.arm === 'text') return { kind: 'text', reason: 'not_profitable', stats: { ...stats, exactText: 1 } };
  const { segments } = fitImageCap(input.text, form.selectedStarts, form.minImageLines, input.maxImageSegments);
  if (!segments.some((segment) => segment.kind === 'image')) return { kind: 'text', reason: 'not_profitable', stats };
  return { kind: 'segments', segments, stats: { ...stats, exactInterleave: 1 } };
}

/** The auto-jev hook: Jev picks exact positions, the cost estimate picks interleave or text. */
export function createExactHook(options: ExactHookOptions): SplitBlock {
  const minImageLines = options.minImageLines ?? DEFAULT_MIN_IMAGE_LINES;
  return async (input) => {
    const key = options.forms ? await formKey(input.site, input.text) : undefined;
    const stored = key === undefined ? undefined : options.forms!.get(key);
    if (stored) return planFromForm(input, stored, { exactLocked: 1 });
    const candidates = findExactCandidates(input.text, input.protectedSpans);
    const selection = candidates.length === 0 ? new Set<number>() : await options.jev(input.text, candidates);
    if (selection === 'pending') return { kind: 'text', reason: 'pending', stats: { exactPending: 1 } };
    const selectedStarts = [...selection].map((index) => candidates[index]!.start).sort((left, right) => left - right);
    const fitted = fitImageCap(input.text, selectedStarts, minImageLines, input.maxImageSegments);
    const estimate = estimateInterleave(input.text, fitted.segments, input.cost);
    const form: ExactForm = chooseArm(estimate) === 'interleave'
      ? { arm: 'interleave', selectedStarts, minImageLines: fitted.minImageLines }
      : { arm: 'text' };
    if (key !== undefined) options.forms!.set(key, form);
    return planFromForm(input, form, {
      exactCandidates: candidates.length,
      exactSelected: selection.size,
      exactLines: input.text.split('\n').length,
      exactSelectedLines: countLines(input.text, selectedStarts),
      exactTextTokens: estimate.textTokens,
      exactInterleaveTokens: estimate.interleaveTokens,
    });
  };
}
