# GEO - Generative Engine Optimisation

Phase 3 in the PRD roadmap, built now as a standalone system. It answers one
question for an SMB: **when someone asks an AI assistant about businesses like
mine, do I show up, and what does it say about me?**

## Pipeline

```
cron scheduler --> geo-sweep queue --fan-out per engine--> geo-probe queue
                                                                |
                            +-----------------------------------+---------+
                            |  1. ask the engine (AnswerEngineClient)     |
                            |  2. persist probe_runs (raw answer + cites) |
                            |  3. analyse -> mentions                     |
                            |  4. write cost_events                       |
                            +-----------------------------------+---------+
                                                                |
                                     geo-rollup --> visibility_snapshots --> dashboard
```

The raw answer is written **before** analysis, so a bug in the analyser never
costs a paid probe. Re-scoring history is a re-run of step 3 over stored text.

## Scheduling

Cadence is per prompt: `tracked_prompts.schedule` holds a cron expression, and
the worker registers one BullMQ job scheduler per active prompt. BullMQ rather
than node-cron because the schedule then lives in Redis — it survives a restart,
and two worker replicas produce one tick instead of two.

Schedulers are reconciled against the database on an interval
(`GEO_SCHEDULER_SYNC_MS`, default 60s) rather than at write time, because
`geo-api` creates prompts but holds no reference to the worker's queues. That
interval is the lag between creating a prompt and it starting to probe. The same
pass removes schedulers for prompts that were deactivated or deleted, and an
unparseable cron is logged and skipped so one bad row can't stop the rest.

Roll-ups run on their own global tick (`GEO_ROLLUP_CRON`) over a trailing window
(`GEO_ROLLUP_WINDOW_DAYS`), deliberately **not** chained to sweep completion: a
roll-up aggregates whatever runs exist in its window, so it never has to know
whether every probe of a cycle has landed, and one slow engine can't stall the
metric. It replaces the snapshot for its window rather than appending, so a
re-fired tick doesn't put a step in the trend chart that never happened.

## Failed probes are data

When an engine call throws, the run is still written, with `error` set and empty
`answer_text`. The roll-up then excludes those rows from every metric. This
matters more than it looks: an engine that rate-limited us did not decline to
mention the brand, and counting the failure as a miss would quietly depress
presence and share of voice — the system would report a visibility problem that
is really an infrastructure problem.

## Why fan out per (prompt, engine)

One job per prompt would mean a rate-limited or slow engine stalls the whole
sweep. One job per pair lets each engine fail, retry, and back off on its own.
The job id is `promptId-engine-YYYY-MM-DDTHH`, so re-triggering a sweep within
the same hour is a no-op instead of a double charge.

## Metrics

Defined once, in `packages/shared/src/geo/visibility.ts`:

| Metric            | Definition                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `presenceRate`    | Share of **runs** (not mentions) where the brand appeared at all |
| `averagePosition` | Mean 1-based order among named businesses, when present          |
| `shareOfVoice`    | Brand mentions / all entity mentions across the prompt set       |
| `citationRate`    | Share of brand mentions backed by a source URL                   |
| `sentimentScore`  | Mean of +1 / 0 / -1 over brand mentions                          |
| `geoScore`        | 0-100, weighted 45 / 20 / 20 / 15 (presence dominates)           |

Presence is measured per run because being named three times in one answer is
still one answer that mentioned you.

## Engine coverage

| Engine       | Adapter status | Notes                                                      |
| ------------ | -------------- | ---------------------------------------------------------- |
| `claude`     | Implemented    | Server-side web search enabled                             |
| `perplexity` | Implemented    | Cleanest citation signal of any engine                     |
| `chatgpt`    | Stub           | Responses API + hosted web search - pending provider spike |
| `gemini`     | Stub           | Google Search grounding - pending provider spike           |

`GET /api/health` lists which engines actually have credentials, so an empty
sweep is diagnosable in one request rather than by reading logs.

## Methodology caveat, keep it visible

These adapters probe **API surfaces**, which are not byte-identical to what a
consumer sees in the ChatGPT or Claude app - different system prompts, different
tool configuration, no personalisation or chat history. The trend is meaningful;
the absolute number is a proxy. Say so in the UI rather than letting a customer
discover it.

## Analyser prompt is the instrument

`apps/geo-worker/src/pipeline/analyze.ts` holds the extraction prompt. It is
deliberately conservative: entities only count when explicitly named, `excerpt`
must be verbatim, and nothing is inferred from the model's own knowledge of the
brand. Changing it changes the metric - re-run against stored `answer_text` and
compare before shipping.
