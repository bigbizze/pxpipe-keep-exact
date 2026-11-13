/**
 * Jev (TypeSafe decision model, via the OpenRouter Decisions API) as an
 * ExactSelector: one yes/no question per candidate POSITION, with the text
 * around that position as context.
 *
 * Decisions are stored by sha256(token + context) and never asked again, so a
 * block always gets the same selection (prompt-cache safe). Failed calls are not
 * stored, so an outage or a bad key does not lock a block into a form.
 *
 * With `wait: false` (the proxy), a block with unanswered positions returns
 * `pending` at once and the questions run in the background; the caller keeps
 * the block as text until a later turn finds every decision stored. After a
 * failed call, no new questions are sent for `retryAfterMs`.
 * With `wait: true` (the eval), an unanswered position is selected for that
 * call only: keeping a value exact is the safe direction.
 */

import { memoryStore, type ExactCandidate, type ExactSelector, type KeyValueStore } from './exact-values.js';

export const JEV_MODEL = 'typesafe/jev-1.14';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export interface JevStats {
  calls: number;
  questions: number;
  cacheHits: number;
  failures: number;
  costUsd: number;
  latencyMs: number;
  selected: number;
  candidates: number;
}

export type JevDecisionStore = KeyValueStore<number>;

export interface JevSelectorOptions {
  readonly apiKey: string;
  /** Characters of text on each side of the token. Default 240. */
  readonly contextChars?: number;
  /** Select when P(yes) >= threshold. Default 0.5. */
  readonly threshold?: number;
  /** Questions per Decisions call. Default 150. */
  readonly batchSize?: number;
  /** Parallel calls. Default 8. */
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly store?: JevDecisionStore;
  readonly stats?: JevStats;
  readonly fetchImpl?: typeof fetch;
  /** false: return `pending` instead of waiting for Jev. Default true. */
  readonly wait?: boolean;
  /** wait false: no new questions for this long after a failed call. Default 60000. */
  readonly retryAfterMs?: number;
}

export function emptyJevStats(): JevStats {
  return { calls: 0, questions: 0, cacheHits: 0, failures: 0, costUsd: 0, latencyMs: 0, selected: 0, candidates: 0 };
}

export const memoryDecisionStore = (): JevDecisionStore => memoryStore<number>();

const STATE =
  'Text that an AI agent will read from an image. Misread characters in an image are a risk only for ' +
  'values that cannot be inferred from context.';

const CRITERIA = {
  true:
    'yes: a specific value with arbitrary characters (id, hash, number, path, version, url, name of a ' +
    'specific file or identifier)',
  false: 'no: a field name, keyword, label, common word, or a token that is predictable from the surrounding text',
};

function question(token: string, context: string): string {
  return (
    `Context: ${context}\nIs the marked token ⟪${token}⟫ a specific value (not a name of a field, keyword ` +
    'or syntax) whose exact characters cannot be recovered from the context if one character is misread?'
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function contextFor(text: string, candidate: ExactCandidate, radius: number): string {
  const from = Math.max(0, candidate.start - radius);
  const to = Math.min(text.length, candidate.end + radius);
  return (
    text.slice(from, candidate.start) + '⟪' + candidate.value + '⟫' + text.slice(candidate.end, to)
  );
}

interface Pending {
  readonly index: number;
  readonly key: string;
  readonly context: string;
  readonly token: string;
}

async function askBatch(
  batch: readonly Pending[],
  options: JevSelectorOptions,
  stats: JevStats,
): Promise<Map<string, number>> {
  const questions: Record<string, unknown> = {};
  batch.forEach((item, position) => {
    questions[`q${position}`] = {
      type: 'noul',
      instructions: question(item.token, item.context),
      criteria: CRITERIA,
    };
  });
  const result = new Map<string, number>();
  try {
    const response = await (options.fetchImpl ?? fetch)(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state: STATE, questions }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const body = (await response.json()) as {
      answers?: Record<string, { type?: string; noul?: number }>;
      usage?: { cost?: number };
    };
    stats.calls++;
    stats.costUsd += body.usage?.cost ?? 0;
    if (!response.ok || !body.answers) {
      stats.failures += batch.length;
      return result;
    }
    batch.forEach((item, position) => {
      const answer = body.answers![`q${position}`];
      if (answer?.type === 'noul' && typeof answer.noul === 'number') result.set(item.key, answer.noul);
      else stats.failures++;
    });
  } catch {
    stats.calls++;
    stats.failures += batch.length;
  }
  return result;
}

export function jevSelector(options: JevSelectorOptions): ExactSelector {
  const radius = options.contextChars ?? 240;
  const threshold = options.threshold ?? 0.5;
  const batchSize = options.batchSize ?? 150;
  const concurrency = options.concurrency ?? 8;
  const store = options.store ?? memoryDecisionStore();
  const stats = options.stats ?? emptyJevStats();
  const inFlight = new Set<string>();
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  let failedAt = -Infinity;

  async function ask(pending: readonly Pending[]): Promise<void> {
    const batches: Pending[][] = [];
    for (let at = 0; at < pending.length; at += batchSize) batches.push(pending.slice(at, at + batchSize));
    stats.questions += pending.length;
    const started = Date.now();
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        const answers = await askBatch(batch, options, stats);
        for (const item of batch) {
          const probability = answers.get(item.key);
          if (probability !== undefined) store.set(item.key, probability);
        }
        if (answers.size < batch.length) failedAt = Date.now();
      }
    });
    await Promise.all(workers);
    stats.latencyMs += Date.now() - started;
  }

  return async (text, candidates) => {
    const keys: string[] = [];
    const pending: Pending[] = [];
    const queued = new Set<string>();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const context = contextFor(text, candidate, radius);
      const key = await sha256Hex(`${candidate.value}\u0000${context}`);
      keys.push(key);
      if (store.get(key) !== undefined) stats.cacheHits++;
      else if (!queued.has(key)) {
        queued.add(key);
        pending.push({ index, key, context, token: candidate.value });
      }
    }
    if (pending.length > 0) {
      if (options.wait === false) {
        if (Date.now() - failedAt < retryAfterMs) return 'pending';
        const fresh = pending.filter((item) => !inFlight.has(item.key));
        for (const item of fresh) inFlight.add(item.key);
        if (fresh.length > 0) {
          void ask(fresh).finally(() => {
            for (const item of fresh) inFlight.delete(item.key);
          });
        }
        return 'pending';
      }
      await ask(pending);
    }
    const selected = new Set<number>();
    keys.forEach((key, index) => {
      if ((store.get(key) ?? 1) >= threshold) selected.add(index);
    });
    stats.candidates += candidates.length;
    stats.selected += selected.size;
    return selected;
  };
}
