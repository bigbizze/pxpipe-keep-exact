# pxpipe-keep-exact

A `splitBlock` hook for [pxpipe](https://github.com/teamchong/pxpipe). It needs the hook from [teamchong/pxpipe#360](https://github.com/teamchong/pxpipe/pull/360), which is not merged yet.

pxpipe saves input tokens by sending old context as images. Opus 5.5 reads the layout of those images fine, but it misreads single characters inside ids, hashes, paths and numbers. On the verbatim-15 pages, imaged text got 12/15 ids right, and plain text got 15/15.

This hook keeps only the lines that hold those values as text, and lets pxpipe image the rest, in the original order:

```text
pxpipe:              [image: whole tool_result] [factsheet]
pxpipe-keep-exact:   [image: lines 1-149] [text: lines 150-159] [image: lines 160-400]
```

## How it decides

1. Tokenize the block. Every token that is not a plain word is a candidate: `deadbeef`, `fooBarBaz`, `src/core/x.ts`, `0x1f`, `2814`, and so on.
2. For each candidate position, ask Jev (`typesafe/jev-1.14`, TypeSafe's decision model, through the OpenRouter Decisions API) one yes/no question: does this exact token matter here? Each question has about 240 characters of text on each side. Each position is asked about separately, so the same value can be kept in one place and imaged in another.
3. All positions in a block go in one call (up to 150 per call).
4. A line with a selected token stays text. A run of 6 or more other lines becomes an image. Shorter runs stay text.
5. If the split does not save input tokens (using pxpipe's cost function), the whole block stays text.

## Prompt cache

- Jev decisions are stored on disk by sha256(token + context). Jev scores can move a little between runs, so a decision is never asked for twice.
- A block's form is stored the first time it is imaged and does not change after that.
- The proxy never waits for Jev. A block stays text until its decisions are stored, and gets imaged on a later turn.

## Use

Until #360 is merged, use the PR branch of pxpipe:

```bash
git clone -b feat/split-block-hook https://github.com/bigbizze/pxpipe.git
git clone https://github.com/bigbizze/pxpipe-keep-exact.git
(cd pxpipe && pnpm install && pnpm run build)
(cd pxpipe-keep-exact && pnpm install && pnpm run build)
PXPIPE_PLUGIN="$PWD/pxpipe-keep-exact/dist/plugin.js" OPENROUTER_API_KEY=... node pxpipe/bin/cli.js
```

Settings:

- `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`): needed for Jev.
- `PXPIPE_KEEP_EXACT_MIN_IMAGE_LINES`: shortest image run, default 6.
- `PXPIPE_KEEP_EXACT_DIR`: where decisions and forms are stored, default `~/.pxpipe`.

## Results

All runs: `claude-opus-5-5`, 2026-11-12, Claude Code 2.1.308 (`claude -p`, no proxy), dense geometry (312 cols). Same fixtures and golds for every arm. "Tokens" is the content tokens per page (image tokens plus text tokens). The raw answers are in `eval/out/*/results.jsonl`.

verbatim-15 (5 pages, 15 exact-value probes, 2 reps):

| arm | correct | tokens/page | vs text | images/page |
|---|---|---|---|---|
| text | 15/15, 15/15 | 5950 | 0% | 0 |
| pxpipe default | 12/15, 12/15 | 1790 | 70% | 1 |
| keep-exact | 15/15, 15/15 | 5950 | 0% | 0 |

Every line on these pages has an id, so all of them stay text and nothing is saved.

gist-recall (10 pages, 60 probes, a mix of exact values and gist, 2 reps):

| arm | correct | tokens/page | vs text | images/page |
|---|---|---|---|---|
| text | 60/60, 60/60 | 6681 | 0% | 0 |
| pxpipe default | 50/60, 51/60 | 2467 | 63% | 1 |
| keep-exact, N=3 | 60/60, 54/60 | 3665 | 45% | 9.0 |
| keep-exact, N=6 | 60/60, 60/60 | 3446 | 48% | 9.1 |

mixed (6 transcripts with log dumps and id tables, 0-100% of lines holding exact values, 38 probes, 1 rep):

| arm | correct | tokens/page | vs text |
|---|---|---|---|
| text | 38/38 | 6520 | 0% |
| keep-exact, N=6 | 38/38 | 5042 | 23% |

The saving goes down as more lines hold exact values: about 76% at 0%, 59% at 10%, 41% at 25%, 21% at 50%, 6% at 75%, and 0% at 100%.

Jev cost: $0.0465 for the 5 verbatim pages and $0.0402 for the 10 gist pages, at 0.4-0.7 s per page. That is about $0.004-0.009 per page, one time. After that every request reads from the cache.

These are synthetic fixtures. This has not been tested on real Claude Code or Codex traffic yet.

## What didn't work

- Replacing exact values with labels like `⟦1⟧` inside the image, with a legend in text. Opus refused some of those requests (`reasoning_extraction`).
- A regex-only version of the labels design. It had one refusal on the mixed set.

Both are kept in `eval/arms.mjs` as build-only arms. The eval runner will not send them to Anthropic.

## Eval

`eval/run.mjs` refuses to start when `ANTHROPIC_BASE_URL` is set or another eval is running, and it stops at the first refused call.

Rebuild the requests and score the stored answers, with no API calls:

```bash
pnpm run build
node eval/run.mjs --suite mixed --arms text,interleave-jev-n6 --build-only
node eval/score.mjs mixed
node eval/sweep.mjs mixed
```

Fixtures:

- `eval/fixtures/verbatim-15`: from pxpipe's `eval/verbatim-15/gen-fixtures.mjs`, seed 1.
- `eval/fixtures/gist-recall`: tier 1 of pxpipe's `eval/gist-recall/gen.py`: synthetic sessions with pxpipe source as filler and seeded facts.
- `eval/fixtures/mixed`: `node eval/fixtures/mixed/gen.mjs`, seed 7.
