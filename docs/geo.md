# GEO - Generative Engine Optimisation

Phase 3 in the PRD roadmap, built now as a standalone system. It answers one
question for an SMB: **when someone asks an AI assistant about businesses like
mine, do I show up, and what does it say about me?**

## Pipeline

```
tracked_prompts --fan-out per engine--> geo-probe queue
                                             |
                      +----------------------+----------------------+
                      |  1. ask the engine (AnswerEngineClient)     |
                      |  2. persist probe_runs (raw answer + cites) |
                      |  3. analyse -> mentions                     |
                      |  4. write cost_events                       |
                      +----------------------+----------------------+
                                             |
                              geo-rollup --> visibility_snapshots --> dashboard
```

The raw answer is written **before** analysis, so a bug in the analyser never
costs a paid probe. Re-scoring history is a re-run of step 3 over stored text.

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
