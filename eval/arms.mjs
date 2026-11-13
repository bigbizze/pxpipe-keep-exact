import { transformRequest } from 'pxpipe-proxy';
import { createExactHook, emptyJevStats, findExactCandidates, jevSelector, memoryDecisionStore } from '../dist/index.js';
import { patchTokens } from '../node_modules/pxpipe-proxy/dist/core/vision-cost.js';
import { applyExactLabels, findDigitCandidates, interleaveHook } from './hooks.mjs';
import { decodePng } from './png-size.mjs';

export const MODEL = 'claude-opus-5-5';

/**
 * `anthropicSafe: false` arms must never be sent to Anthropic: every labels arm
 * (all, Jev, regex) and the plain image baseline caused Opus reasoning_extraction
 * refusals (labels-regex: mixed suite, m010-hex, rep 0). They are kept only so
 * their builds (tokens, images) can be inspected offline.
 * `offline: true` arms are scored from other arms' answers (see sweep.mjs).
 */
export const ARMS = {
  'text': { anthropicSafe: true },
  'image-baseline': { hook: () => null, anthropicSafe: false },
  'labels-regex': { labels: 'regex', anthropicSafe: false },
  'labels-all': { labels: 'all', anthropicSafe: false },
  'labels-jev': { labels: 'jev', anthropicSafe: false },
  'interleave-all-n3': { hook: () => interleaveHook({ minImageLines: 3 }), anthropicSafe: false },
  'interleave-all-n6': { hook: () => interleaveHook({ minImageLines: 6 }), anthropicSafe: false },
  'interleave-jev-n3': { hook: (jev) => interleaveHook({ jev, minImageLines: 3 }), anthropicSafe: false },
  'interleave-jev-n6': { hook: (jev) => interleaveHook({ jev, minImageLines: 6 }), anthropicSafe: true },
  'auto-jev': { hook: (jev) => createExactHook({ jev, minImageLines: 6 }), anthropicSafe: true, offline: true },
};

export const ANTHROPIC_SAFE_ARMS = Object.keys(ARMS).filter((arm) => ARMS[arm].anthropicSafe && !ARMS[arm].offline);

export function makeJev(apiKey, store = memoryDecisionStore()) {
  const stats = emptyJevStats();
  return { stats, selector: jevSelector({ apiKey, store, stats }) };
}

async function transformOne(text, splitBlock) {
  const req = {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Show me the file.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'data.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: text }] },
    ],
  };
  const { body, info } = await transformRequest(new TextEncoder().encode(JSON.stringify(req)), { model: MODEL, splitBlock });
  const out = JSON.parse(new TextDecoder().decode(body));
  const content = out.messages[2].content[0].content;
  return { parts: typeof content === 'string' ? [{ type: 'text', text: content }] : content, info };
}

async function buildLabels(text, which, jev) {
  const candidates = which === 'regex' ? findDigitCandidates(text) : findExactCandidates(text);
  const selected = which === 'jev' ? await jev(text, candidates) : new Set(candidates.map((_candidate, index) => index));
  const labeled = applyExactLabels(text, candidates, selected);
  const { parts, info } = await transformOne(labeled.text, null);
  const images = parts.filter((part) => part.type === 'image');
  const out = images.length > 0 ? [...images, ...(labeled.legend ? [{ type: 'text', text: labeled.legend }] : [])] : parts;
  return { parts: out, info: { ...info, splitStats: { exactCandidates: candidates.length, exactSelected: selected.size } } };
}

/**
 * Run one source text through the production transform as a single tool_result
 * and return the content parts the model would see.
 */
export async function buildParts(text, arm, jev) {
  const spec = ARMS[arm];
  if (!spec) throw new Error(`unknown arm ${arm}`);
  let built;
  if (spec.labels) built = await buildLabels(text, spec.labels, jev);
  else if (!spec.hook) built = { parts: [{ type: 'text', text }], info: null };
  else built = await transformOne(text, spec.hook(jev));
  let imageTokens = 0;
  let images = 0;
  for (const part of built.parts) {
    if (part.type !== 'image') continue;
    const { width, height } = decodePng(Buffer.from(part.source.data, 'base64'));
    imageTokens += patchTokens(width, height);
    images++;
  }
  return { parts: built.parts, images, imageTokens, stats: built.info?.splitStats ?? {} };
}
