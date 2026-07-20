## Product Requirements Document

## Multi-Agent Brand Marketing System — Phase 1: Creative Content Agent

| Document status Draft v1.0 Date 17 July 2026               |
| ---------------------------------------------------------- |
| Owner Subhrajyoti Phase 10f N (Creative Content Agent MVP) |

## 1. Vision & Background

We are building a multi-agent brand marketing system for small and medium-sized businesses (SMBs) — businesses that cannot afford a design agency, a copywriter, and a social media but need all three to compete online. manager,

The long-term product is a suite of cooperating Al agents that together function as an outsourced marketing department: creative production, copywriting, publishing, brand monitoring, and campaign intelligence.

Phase 1 ships the first and most valuable agent: a Creative Content Agent. The user supplies their brand name, a product description, reference/product images, and a few essential details. The agent returns:

- 1. A professional, print/social-ready poster, banner, or ad image featuring their actual product.

- 2. Accompanying marketing copy (caption, headline, hashtags, CTA) matched to the target platform.

Both are ready to publish on the business's online store and social pages with zero design skill required.

## 2.Problem Statement

SMB owners (boutique stores, restaurants, D2C sellers, local service providers) face a persistent gap:

- « Design is expensive and slow. A single professional poster from a freelancer costs \$20-\$150 and takes days of back-and-forth.

- \+ DIY tools still require design skill. Canva templates look templated; the owner still has to write copy, choose layouts, and match brand colors.

- « Generic Al image tools fail on the specifics. Raw Midjourney/DALL-E outputs can't reliably place their actual product in the image, render legible promotional text, or respect brand colors/logos.

- « Consistency collapses. Every post looks different because there's no persistent brand memory.

The result: SMBs post rarely, post low-quality creative, or don't post at all — and lose visibility to competitors who can afford agencies.

## 3. Goals & Non-Goals

## 3.1 Goals (Phase 1 MVP)

| # Goal Success signal G1 Generate a usable ad/poster/banner from brand >70% of generations accepted without                                                                                                                                                                   |     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| inputs in under 2 minutes regeneration by test users G2 Product fidelity: the user's actual product (from Human eval on 50-sample test set                                                                                                                                    |     |
| reference images) appears recognizably in the output                                                                                                                                                                                                                          |     |
| G3 Legible, correctly spelled on-image text (offer, price, ~<5% text-error rate brand name) G4 Matching copy pack (caption + hashtags + CTA) per Generated in the same run platform G5 Persistent Brand Kit so every future generation is Brand kit reused across >2 sessions |     |
| on-brand G6 Architecture that cleanly extends to future agents Model-agnostic generation layer; (video, publishing, monitoring) agent orchestration pattern documented                                                                                                        |     |

## 3.2 Non-Goals (explicitly out of scope for Phase 1)

- « Video/ Reels generation (Phase 2 — see roadmap).

- « Auto-publishing to social platforms (Phase 2/3).

- « Influencer/creator campaign management.

- « Alsearch visibility (GEO) tracking.

- « Paid ads campaign management (Meta/Google Ads APIs).

- « Multi-user teams, client approval workflows, white-labeling.

- \+ Fine-tuning or self-hosting image models.

## 4. Target Users & Personas

Primary market: Small and medium businesses, initially India-first (price-sensitive, WhatsApp/Instagram-heavy), designed to work globally.

| Persona Description Core job-to-be-done P1—Boutique/D2Cowner Instagram + WhatsApp; "Turn my product photo into a ("Priya, saree boutique") phone photos of products; no festival-sale poster I can post                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| design skill today"                                                                                                                                                                                                                                                                |
| P2 — Restaurant/café Needs daily specials, offer "New combo offer poster with owner banners, menu highlights price, every week" P3 — Local service provider Needs promotional bannersand "Professional-looking promo (salon, gym, coaching) seasonal offers without hiring anyone" |
| P4 — Solo marketer / Manages 3-10 SMB clients "Produce on-brand creative for                                                                                                                                                                                                       |
| freelancer (secondary) many brands, fast"                                                                                                                                                                                                                                          |

Key user constraints to design for: mobile-first usage, low tolerance for prompt-writing, poor-quality input photos (busy backgrounds, bad lighting), regional-language copy needs (Hindi/Tamil/etc. as fast-follow).

## 5. Inspiration & Competitive Analysis

Features we are deliberately borrowing (and deferring) from the reference products:

| Product ‘What they do ‘What we take for Phase =~ What we defer to later                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 phases                                                                                                                                                            |
| GetMentioned visibility: Nothing in Phase Visibility/perception                                                                                                     |
| mentions, perception, their MCP server pattern agent; public API + source attribution, as a distribution idea for MCP server competitor benchmarking, our own suite |
| API/MCP access                                                                                                                                                      |

Positioning gap we occupy: none of the above serves the

SMB with a static

image + copy product at Indian-SMB price points. Videotok/ReelPilot are video-first and creator-oriented; Saharan is Amazon-locked; Nas is enterprise; AI Carma/GetMentioned are monitoring-only. We start where the SMB's need is most frequent and cheapest to serve — static promotional creative — and expand outward.

## 6. Product Scope — Phase 1 Functional Requirements

## 6.1 User Flow (happy path)

## 6.2 FR-1: Brand Kit (the "Brand Brain", minimal version)

| ID            | Requirement Priority                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR- 11        | User can create a Brand Kit: brand name, logo upload, 1-3 brand colors (picker or Must auto-extracted from logo), tone of voice (dropdown: friendly / premium / playful / |
|               | traditional), business category, target audience blurb                                                                                                                    |
| FR- 12 FR- 13 | User can add products: name, description, price (optional), 1-5 reference photos Must each Brand Kit persists and auto-applies to every generation Must                   |
| FR- 14        | Auto-suggest kit from the business's Instagram handle or website URL (scrape Should name, logo, colors)                                                                   |

| ID Requirement Priority                                      |
| ------------------------------------------------------------ |
| FR- Multiple brands per account (agency persona P4) Could 15 |

## 6.3 FR-2: Creative Request Intake

| ID Requirement Priority                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR- Structured request form — NOT freeform prompting: select product, campaign Must 21 type (offer/launch/festival/generic post), key text to display (offer %, price, tagline), output format |
| FR- Output format presets with correct dimensions: Instagram post 1:1 (1080x1080), Must 22 Story/Reel cover 9:16 (1080x1920), Facebook/website banner 16:9 or 1200x628,                        |
| Poster A4-ratio (print-intent)                                                                                                                                                                 |
| FR- Style/reference template gallery (ala Videotok): user picks a look ("festive", Must                                                                                                        |
| 23 "minimal luxury", "bold discount", "flat-lay product hero"); the system composes                                                                                                            |
| the generation prompt — the user never writes a prompt                                                                                                                                         |
| FR- Optional freeform "extra instructions" field Should                                                                                                                                        |
| 24                                                                                                                                                                                             |
| FR- intake as an alternative to the form Could                                                                                                                                                 |
| 25                                                                                                                                                                                             |

## 6.4 FR-3: Image Generation

| ID Requirement Priority                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR- Generate the creative using the selected image model with: (a) reference product ~~ Must                                                                                      |
| 3.1 image(s) as visual conditioning, (b) brand colors and logo, (c) required on-image text rendered legibly and spelled correctly, (d) chosen aspect ratio                        |
| FR- Produce 2-4 variants request for the user to choose from Must per 3.2                                                                                                         |
| FR- Iterative edit loop: user gives a natural-language revision ("remove the shadow", Must 3.3 "make text gold") agent performs a targeted edit of the chosen variant, not a full |
| regeneration                                                                                                                                                                      |

| ID Requirement Priority                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR- Logo overlay fallback: if the model mangles the logo, composite the actuallogo file Must 3.4 programmatically (e.g., sharp/Pillow post-processing) at a template-defined safe |
| position FR- Text QA pass: a vision-model check reads back on-image text and flags Should                                                                                         |
| 3.5 misspellings; auto-retry once on failure                                                                                                                                      |
| FR- Background removal / cleanup of user product photos before conditioning Should 3.6 (improves fidelity from messy phone photos)                                                |
| FR- Upscale final selected image for print-intent formats Could 37                                                                                                                |

## 6.5 FR-4: Copy Generation

| Requirement Priority                                                                               |
| -------------------------------------------------------------------------------------------------- |
| FR- Generate a copy pack alongside every image: headline, caption (platform- ~~ Must               |
| 4.1 length-aware), 8-15 relevant hashtags, CTA line FR- Copy respects Brand Kit tone of voice Must |
| 4.2 FR- Per-platform variants (Instagram vs. Facebook vs. WhatsApp broadcast Should                |
| 4.3 text)                                                                                          |
| FR- Regional language copy (Hindi, Tamil, Bengali, etc.) on request Should (fast- 4.4 follow)      |

## 6.6 FR-5: Output, History & Delivery

| ID Requirement Priority                                                                     |
| ------------------------------------------------------------------------------------------- |
| FR-5.1 Download final image (PNG/JPG at full resolution); one-tap copy of caption text Must |
| FR-5.2 Generation history per brand; re-run/remix any past creative Must                    |
| FR-5.3 Share-to-WhatsApp / native share sheet (mobile) Should                               |
| FR-5.4 Watermark on free tier; removed on paid Should                                       |

## 6.7 FR-6: Accounts, Credits & Safety

| Requirement                                                                                                                                                           | Priority |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR- Auth (email/Google OAuth), brand data isolation per account                                                                                                       | Must     |
| 6.1 FR- Credit system: each generation consumes credits; free tier with N credits/month;                                                                              | Must     |
| 6.2 paid tiers                                                                                                                                                        |          |
| FR- Content safety: block generation of prohibited content (celebrity likeness, 6.3 competitor logos, regulated-category claims); rely on provider safety filters + a | Must     |
| lightweight request classifier                                                                                                                                        |          |
| FR- Ratelimiting and per-user cost caps to bound spend 6.4                                                                                                            | Must     |

## 7. The Core Decision: Image Generation Model / API

This is the immediate build decision. Requirements ranked by importance for our use case:

- 1. Reference-image conditioning — must place the user's actual product faithfully (multi-image input).

- . Text rendering — posters live or die on legible offer text, prices, brand names.

- . Instruction-following edits — conversational, targeted edits without full regeneration.

- . Cost per image — SMB pricing must be paise-to-few-rupees at the margin).

- . Latency — target <60s end-to-end.

- . API maturity, rate limits, and commercial usage rights.

## 7.1 Candidate comparison

| Criterion Google OpenAl Seedream Ideogram SDXL Gemini GPT Flux Kontext (ByteDance, self-h                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| image Image (BFL, via via fal.ai)                                                                                                                                                     |
| family fal.ai/Replicate) (Nano Banana / Nano                                                                                                                                          |
| Banana Pro) Multi- Good Excellent Good Limited Requi                                                                                                                                  |
| reference multi-image (Kontext is Adapt product input, edit/reference- engin fidelity strong specialized) subject                                                                     |
| consistency                                                                                                                                                                           |
| On-image text Best-in- Very good Good Good Very good Weak rendering class, incl. (typography- multilingual focused) Conversational Native Good Strong (Kontext Moderate Moderate Manu |
| editing strength edit mode) inpait                                                                                                                                                    |
| (chat-based pipeli                                                                                                                                                                    |
| iterative edits)                                                                                                                                                                      |
| Costper1080p Low (Flash ~~ Moderate- Low-moderate Lowest Moderate Infra« image tier) to high via aggregators GPU ¢ (approx.) moderate burde (Pro tier)                                |
| Latency Fast (Flash) Moderate Fast Fast Fast Depel infra                                                                                                                              |
| APImaturity/ Mature Mature Mature via Via Mature N/A SDKs (Google AI fal/Replicate aggregators Studio / Vertex)                                                                       |

| Criterion Google OpenAl Flux2Pro/ Seedream Ideogram SDXL Gemini GPT Flux Kontext (ByteDance, self-h image Image (BFL, via via fal.ai)                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| family fal.ai/Replicate)                                                                                                                                                                                                    |
| (Nano                                                                                                                                                                                                                       |
| Nano Banana                                                                                                                                                                                                                 |
| Pro) Commercial Yes Yes Yes (API tiers) Check Yes Yes rights aggregator terms                                                                                                                                               |
| Risk notes SynthID Costat Twovendorsin ~~ Newer Not High: watermark scale; chain (BFL + vendor reference- (invisible; stricter aggregator) terms; image-first forM acceptable); content brand- safety filters policy safety |
| can be maturity conservative                                                                                                                                                                                                |

## 7.2 Recommendation

Primary: Google Gemini image model ("Nano Banana" tier for volume, Pro tier for hero/print assets).

Rationale: it is the only candidate that is simultaneously top-tier at the three things our product cannot compromise on — multi-reference product fidelity, correctly rendered (and multilingual) on-image text, and chat-style iterative editing — while the Flash-tier pricing fits SMB unit economics. Multilingual text rendering also directly unlocks the India- regional roadmap.

Secondary (behind the same abstraction): Flux Kontext via fal.ai for targeted edit operations and as failover; Seedream as the cheap bulk/variants engine if volume economics demand it.

Verify before committing (1-day spike): current model names, per-image pricing, rate limits, and image-input caps change frequently — confirm against live Google Al / fal.ai docs at implementation time and lock versions in config.

## 7.3 Architectural requirement: model abstraction layer

All generation calls go through an internal

interface:

Provider adapters (GeminiAdapter, FalFluxAdapter, ...) are config-selected per operation type. No product code may call a provider SDK directly. This is what lets us ride the model-release treadmill (the Videotok "all models, one subscription" pattern) without rewrites, and lets us A/B providers on cost/quality.

## 8. System Architecture (Phase 1)

## 8.1 Agent pipeline

Phase 1is one user-facing agent implemented as an orchestrated pipeline of specialized sub-steps — the same pattern future agents will follow:

- « Orchestration LLM: Claude (Haiku for Brief/Copy at volume; Sonnet for QA judgment calls) — consistent with the team's existing stack. Keep this provider- swappable too.

- \+ Asyncjob model: generation requests are queued jobs (BullMQ/Redis or equivalent); client polls or receives websocket updates. Mirrors the async-TTS job pattern already proven in the Nirvanta backend.

## 8.2 Suggested stack (aligned with team skills)

|      | Layer Choice                                                                                                                                                           |     |     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- |
|      | Backend TypeScript + Express (or NestJS), Drizzle ORM, PostgreSQL                                                                                                      |     |     |
|      | Job queue BullMQ + Redis                                                                                                                                               |     |     |
|      | Storage/CDN S3-compatible (R2/S3) with signed URLS for outputs; originals kept for remix Frontend Next.js or Angular, mobile-first responsive; PWA share-sheet support |     |     |
| Auth | OAuth (Google) + email; JWT with refresh rotation Payments Razorpay (India) + Stripe (international), credit ledger table                                              |     |     |
|      | ~~ Per-generation cost logging (tokens + image calls) — mandatory from day 1                                                                                           |     |     |
|      | Observability                                                                                                                                                          |     |     |

## 8.3 Data model (core entities)

| (user -» Brand (BrandKit) » Product (ReferenceImages[]) - GenerationJob -» CreativeAsset |
| ---------------------------------------------------------------------------------------- |
| (variants, chosen, edits[]) + CopyPack)—                                                 |

## 9. Non-Functional Requirements

|      | Category Requirement                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|      | Performance P50 end-to-end generation <60s; P95 <120s; UI communicates progress per                                                                                                                      |
|      | pipeline stage                                                                                                                                                                                           |
| Cost | Fully-loaded marginal cost per accepted creative tracked per user; target <15%                                                                                                                           |
|      | of the credit price it consumes                                                                                                                                                                          |
|      | Reliability Job retry with idempotency keys; provider failover via abstraction layer; no lost                                                                                                            |
|      | jobs on deploy                                                                                                                                                                                           |
|      | Scalability Stateless API + queue workers; horizontal worker scaling for generation load Security & Brand assets are private per account; signed, expiring URLS; no training on user                     |
|      | privacy images without opt-in; delete-brand purges assets Compliance Terms must state Al-generated content and user responsibility for offer accuracy; respect provider usage policies; disclosure where |

|     | Category Requirement                                                                      |
| --- | ----------------------------------------------------------------------------------------- |
|     | platforms require it                                                                      |
|     | Localization- UTF-8 everywhere; copy layer prepared for Indic languages; currency display |
|     | readiness                                                                                 |

## 10. Roadmap Beyond Phase 1

|     | Phase Notes                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     | Agent Inspiration source                                                                                                                                                                                                                                                                                                                                   |
| 1   | Creative Content Agent (this PRD) Saharan, Images + copy                                                                                                                                                                                                                                                                                                   |
|     | Videotok                                                                                                                                                                                                                                                                                                                                                   |
|     | templates                                                                                                                                                                                                                                                                                                                                                  |
| 1.5 | Template & remix library growth; Videotok Highest-leverage retention                                                                                                                                                                                                                                                                                       |
|     | regional-language copy; brand auto- ~~ referencelibrary features import from IG/website                                                                                                                                                                                                                                                                    |
| 2   | Video/Reel Agent — product ad Videotok, Reuses Brand Kit + reels, image-to-video from Phase 1 ReelPilot orchestration; adds video assets model adapters (Veo/Kling/Seedance class) + TTS                                                                                                                                                                   |
| 2 3 | Publishing Agent — connect ReelPilot auto- Requires Meta API review; schedule, per-platform post, Videotok significant compliance lift caption rewrites, best-time posting scheduler Campaign Planner Agent — content Nas "campaigns Sits above Creative + calendar, festival/seasonal campaign ~~ not content" Publishing agents packs, multi-post series |
| 3   | Brand Visibility Agent — track how Al Carma, Cheap to prototype; strong ChatGPT/Gemini/Perplexity describe ~~ GetMentioned differentiator bundled for                                                                                                                                                                                                      |
|     | the business locally; weekly digest SMBs                                                                                                                                                                                                                                                                                                                   |
| 4   | Approval workflows & multi-client Infloxy, Monetizes P4 persona                                                                                                                                                                                                                                                                                            |
|     | workspace for freelancers/agencies; GetMentioned MCP                                                                                                                                                                                                                                                                                                       |
|     | public API + MCP server                                                                                                                                                                                                                                                                                                                                    |

The Phase-1 architectural commitments that make this roadmap cheap: shared Brand Kit, model-abstraction layer, queue-based agent pipeline, per-generation cost telemetry.

## 11. Success Metrics (Phase 1)

|     | Metric Target (first 90 days post-launch) Activation: signup -> first accepted creative 250% First-pass acceptance (no regeneration needed) 270% |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
|     | Time-to-first-creative <5 min including onboarding ‘Weekly returning brands >30% of activated                                                    |
|     | Creatives per active brand per week >2                                                                                                           |
|     | Free -> paid conversion >5%                                                                                                                      |
|     | Marginal cost per accepted creative Within unit-economics target                                                                                 |
|     | Text-error rate on shipped creatives <5%                                                                                                         |

## 12. Risks & Open Questions

| #     | Risk / question Mitigation / decision needed                                                                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | Model can't reliably reproduce fine product Asset-prep cleanup step; input-photo quality                                                                                                                                                                                                           |
|       | details (jewelry, textile patterns) from poor ~~ guidance in UT; Pro-tier model for detail- phone photos critical categories                                                                                                                                                                       |
| R2 R3 | On-image text still occasionally garbles, QA vision pass + auto-retry; programmatic especially regional scripts text-overlay fallback template for critical text API costs erode margin at free Cheap model for variants, premium only for tier final; hard credit caps; cost telemetry from day 1 |
| R4    | Provider policy/pricing changes Abstraction layer + second adapter live from                                                                                                                                                                                                                       |
|       | launch                                                                                                                                                                                                                                                                                             |

| # Risk / question Mitigation / decision needed RS Users generate misleading offers or Safety classifier on intake + provider filters + infringing content (competitor logos, ToS celebrities) R6 Crowded market (Canva Al, Meta's own ad Differentiate on India-SMB pricing, regional tools, AdCreative.ai) language, WhatsApp-native delivery, and the multi-agent roadmap Ql Pricing: credits vs. flat monthly? Launch Decide before beta; suggest = cost price point for India? of one freelancer poster Q2 Mobile app vs. mobile-web PWA first? PWA recommended for MVP speed Q3 Do we watermark free-tier outputs withour ~~ A/Bin beta |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brand (growth loop) or keep clean?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Q4 Exact model versions/pricing at build time 1-day spike against live Gemini + fal.ai docs; lock in config                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 13. MVP Definition of Done

Phase 1 ships when a new user can, on a mobile browser: create a Brand Kit with logo and one product photo -» request a "20% off festival sale" Instagram post - receive 3 variants with correct brand name and offer text within 2 minutes -> make one conversational edit > download the image and copy the caption -> and repeat next week with the brand kit already remembered.
