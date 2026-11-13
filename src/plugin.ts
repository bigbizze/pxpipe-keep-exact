import os from 'node:os';
import path from 'node:path';
import type { SplitBlock } from 'pxpipe-proxy';
import { createExactHook, DEFAULT_MIN_IMAGE_LINES, type ExactForm } from './exact-values.js';
import { fileStore } from './file-store.js';
import { jevSelector } from './jev-selector.js';

/**
 * The hook for `PXPIPE_PLUGIN=pxpipe-keep-exact`. Reads OPENROUTER_API_KEY (or
 * OPENROUTER_KEY), PXPIPE_KEEP_EXACT_MIN_IMAGE_LINES and PXPIPE_KEEP_EXACT_DIR (default
 * ~/.pxpipe). Jev runs in the background: a block stays text until its
 * decisions are stored, so a request never waits for Jev.
 */
function pluginFromEnv(): SplitBlock {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
  if (!apiKey) throw new Error('pxpipe-keep-exact needs OPENROUTER_API_KEY (or OPENROUTER_KEY) for Jev');
  const dir = process.env.PXPIPE_KEEP_EXACT_DIR?.trim() || path.join(os.homedir(), '.pxpipe');
  return createExactHook({
    jev: jevSelector({ apiKey, store: fileStore<number>(path.join(dir, 'jev-decisions.json')), wait: false }),
    forms: fileStore<ExactForm>(path.join(dir, 'exact-forms.json')),
    minImageLines: Number(process.env.PXPIPE_KEEP_EXACT_MIN_IMAGE_LINES ?? '') || DEFAULT_MIN_IMAGE_LINES,
  });
}

export default pluginFromEnv();
