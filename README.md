# dsh-compact

**Compaction telemetry & shadow-cost reporting for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

Every time dsh compacts your context it shadows tens of thousands of tokens behind a summary — and pays a one-shot LLM call to write that summary. The compaction/* events carry all of this (`shadowedTokenCount`, the summary's `usage`, provider/model, failure codes), but there is no way to see it without trawling the session log. dsh-compact listens to the `session/event` firehose and turns the lifecycle into accounting:

- **What left the surface** — shadowed tokens per compaction, cumulative
- **What it cost** — summary LLM usage per compaction (tokens of the summarization call itself)
- **Net effect** — shadowed minus summary tokens: the actual surface reduction
- **Reliability** — failed attempts (`busy` / `cancelled` / `summary` / …) counted separately, crash-recovered `compaction/summary` without a matching start still recorded

All of it via one command:

```
/compact-stats
```

```
dsh-compact — 2 compaction(s), 0 failure(s)
shadowed 60,000 tok · summaries ~1,900 tok · net −58,100 tok on the surface
summary LLM cost: 60,400 tok across calls

time               turn   shadowed   summary   model
14:32:05           7      12,000     ~500      deepseek-chat
14:29:11           3      48,000     ~1,400    deepseek-chat
```

## Install

```bash
dsh plugin --profile <name> add dsh-compact
# or from git:
dsh plugin --profile <name> add github:leesama/dsh-compact
```

## Configure

```yaml
- id: compact
  name: dsh-compact
  config:
    reportRows: 10     # rows in the /compact-stats table
    persist: true      # persist records across restarts via the injected store
```

## How it works

```
session/event (firehose)
  ├─ compaction/start    → open a record (manual turns: turn = null)
  ├─ compaction/summary  → attach shadowedTokenCount / summary / usage / model
  └─ compaction/end      → close the record (error? → failure row)
                            → persist via the injected store
commands
  └─ /compact-stats      → table + cumulative totals
```

The fold logic (`src/engine.ts`) is a pure reducer — tolerant of crash-recovery orderings (summary without start, bare failed end) — with full unit coverage. The e2e suite drives `apply()` against a mock session firehose, verifying the full lifecycle amid unrelated events, persistence round-trips, and resume from a persisted store. Persistence goes through a minimal injectable `CompactionStore` contract; the Cordis layer adapts it to `ctx.storageDomain` (JSON or SQLite backend) without touching the accounting logic.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm test            # unit + e2e
npm run test:coverage
npm run build       # tsc → lib/
```

## License

MIT
