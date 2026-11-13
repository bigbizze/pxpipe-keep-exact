import fs from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from './exact-values.js';

/**
 * A JSON-file store. Jev decisions and block forms must survive a proxy
 * restart: a block must keep the same form on every turn, or its rendered bytes
 * change and the prompt cache misses. Writes are debounced and atomic.
 */
export function fileStore<T>(file: string, flushDelayMs = 1000): KeyValueStore<T> & { flush(): void } {
  let entries: Record<string, T> = {};
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, T>;
  } catch {
    entries = {};
  }
  let flushTimer: NodeJS.Timeout | undefined;
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entries));
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    get: (key) => entries[key],
    set: (key, value) => {
      entries[key] = value;
      flushTimer ??= setTimeout(flush, flushDelayMs);
      flushTimer.unref();
    },
    flush,
  };
}
