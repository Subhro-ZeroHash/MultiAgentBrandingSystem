# MarketPulse Web — plan

Status: proposal, 25 Sep 2026. **Built as a standalone Vite + React app in
`internship/demo-web` instead of `apps/web`** — the pages and design below still
apply. Reference design: the Expo app in `internship/demo-frontend`.

## 1. What we're building

A desktop-first website for the same people, the same accounts and the same
backend as the MarketPulse phone app. It covers everything the app does for
real, laid out for a big screen. It's one product in two places: a post
approved on the phone shows as approved on the web, because both read the
same API.

**In scope:** every app feature that talks to a real endpoint.

**Out of scope for v1:** anything the app shows as dummy data (billing plans
and payment, the `connect/` marketing page, Google/Facebook sign-in, logo
upload, profile and notification preferences, "Growth Catalysts",
TikTok/Pinterest), plus browser push notifications. None of these has a
backend yet.

**Backend changes:** config only (CSP, CORS). No new API endpoints.

---

## 2. Build it inside `apps/web`, don't start a new app

`apps/web` is a thin shell today, but its foundations are already the ones
this site needs:

| Already in `apps/web`                                                                                                       | Reused for                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next 16 App Router, `typedRoutes`, Tailwind 4                                                                               | Everything                                                                                                                                                  |
| `@bmas/shared` as a dependency                                                                                              | Real Zod types for plans, scheduling, social, GEO visibility, creatives. The app has to copy these by hand in `lib/api.ts`, which is its biggest drift risk |
| Cookie auth: `/api/auth/{login,refresh,logout}` keep the refresh token in an httpOnly cookie and the access token in memory | Sessions. `lib/api.ts` already does 401 → deduped refresh → retry                                                                                           |
| `proxy.ts` sign-in gate                                                                                                     | Sign-in gate (widen the public list, see §7)                                                                                                                |
| `/auth/instagram/callback`, `/privacy`, `/data-deletion`, `/api/asset/[assetId]`                                            | Kept as they are                                                                                                                                            |
| `/trends` page (runs, score bars, generate/schedule actions)                                                                | Restyled into the new shell as Research → Trends                                                                                                            |
| pm2 `web` process plus `nginx/web.conf` on `web.3-24-200-83.sslip.io`                                                       | Deploys with `deploy.sh`, nothing new                                                                                                                       |

**Delete:** the `(studio)` and `(geo)` placeholder pages, the "BMAS" nav in
`app/layout.tsx`, and the current `app/page.tsx`.

---

## 3. How it should look: "Vibrant Pulse" on a desktop

Use the same design system as the app (`demo-frontend/constants/theme.ts`),
so someone moving between phone and laptop sees one product.

### 3.1 Tokens (replace the `@theme` block in `app/globals.css`)

| Token                                                      | Value                                         | Used for                                     |
| ---------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `--color-primary` / `-container` / `-on-container`         | `#a43c12` / `#ff7f50` / `#6c2000`             | CTAs, active nav, links, key numbers         |
| `--color-secondary` / `-container`                         | `#006a65` / `#76f3ea`                         | Success, "scheduled", GEO/visibility accents |
| `--color-tertiary` / `-container`                          | `#6c49b2` / `#b491ff`                         | AI/insight moments, Brand Brain, planner     |
| `--color-error` / `-container`                             | `#ba1a1a` / `#ffdad6`                         | Failures, destructive actions                |
| `--color-surface`                                          | `#f8f9fa`                                     | Page background                              |
| `--color-surface-lowest` / `-low` / `-container` / `-high` | `#ffffff` / `#f3f4f5` / `#edeeef` / `#e7e8e9` | Cards / inset areas / inputs / hover         |
| `--color-on-surface` / `-variant`                          | `#191c1d` / `#57423b`                         | Body text / secondary text                   |
| `--color-outline` / `-variant`                             | `#8b7169` / `#dec0b6`                         | Input borders / dividers                     |
| `--color-instagram`, `--color-google`, `--color-spark`     | `#E4405F`, `#4285F4`, `#FFD700`               | Platform badges, "spark" highlights          |
| `--gradient-primary`                                       | `linear-gradient(135deg, #a43c12, #ff7f50)`   | Primary buttons, hero, progress fills        |

**Type.** Montserrat for headings (600/700/800) and Plus Jakarta Sans for
body and labels (400/600/700). Load both with `next/font/google`, which
self-hosts them at build time, so the CSP can stay `'self'`.

| Style               | Size / line height       | Notes                                                                           |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| display (web only)  | 48 / 56, Montserrat 800  | Landing hero only                                                               |
| headline-lg         | 32 / 40, −0.02em         | Page titles                                                                     |
| headline-md         | 24 / 32                  | Section titles                                                                  |
| headline-sm         | 20 / 28, 600             | Card titles                                                                     |
| body-lg / body-md   | 18 / 28, 16 / 24         | Copy                                                                            |
| label-md / label-sm | 14 / 20 600, 12 / 16 700 | Buttons, chips. Uppercase `label-sm` for step labels ("STEP 1: UPLOAD PRODUCT") |

**Shape and depth.**

- Everything sits on an 8px grid.
- Corner radius is 16 for buttons and inputs, 24 for cards, and fully round for chips and pills.
- Cards are white on the `#f8f9fa` page with a soft shadow (`0 10px 30px rgb(0 0 0 / .05)`) and **no borders**, the same as the app.
- Primary buttons get the coral glow (`0 10px 20px rgb(164 60 18 / .4)`).

**Motion.** Keep it light:

- Cards lift 2px with a deeper shadow on hover.
- Loading states use pulsing skeletons, never a lone spinner.
- The analytics gauges sweep in.
- All of it is disabled under `prefers-reduced-motion`.

**Theme.** Light only in v1, like the app. Everything is CSS variables, so
dark mode later is one extra `@media` block.

**Icons.** The app uses Material Icons. On the web, use `lucide-react`. It's
the only new runtime dependency and its stroke style sits close to Material.

**Voice.** Reuse the app's copy word for word where the feature is the same:
"Here's what's ready for you today", "Needs you", "Let's post", "Ranked by fit
for your brand". Empty states tell the truth ("Nothing strongly relevant right
now") and offer one next step.

### 3.2 App shell

```
┌────────────────┬──────────────────────────────────────────────────────────────────┐
│ ◉ MarketPulse  │  [ Priya Sarees · Fashion, Jaipur ▾ ]           🔔 3    (DR) ▾   │ ← top bar, 64px
│                ├──────────────────────────────────────────────────────────────────┤
│ ⌂  Home        │                                                                  │
│ ✦  Create      │  Page title                                   [ Primary action ] │
│ ▤  Library     │  One-line subtitle in on-surface-variant                        │
│ ✓  Approvals 2 │                                                                  │
│ ◷  Plan        │  Content: max-width 1200px, 32px gutters, 12-column grid,       │
│ ↻  Campaigns   │  24px gaps                                                       │
│                │                                                                  │
│ RESEARCH       │                                                                  │
│ ↗  Trends      │                                                                  │
│ ◎  Intelligence│                                                                  │
│ ?  Ask AI      │                                                                  │
│                │                                                                  │
│ INSIGHTS       │                                                                  │
│ ▦  Analytics   │                                                                  │
│ ★  Reviews     │                                                                  │
│                │                                                                  │
│ ◈  Brand Brain │                                                                  │
│ ⚙  Settings    │                                                                  │
└────────────────┴──────────────────────────────────────────────────────────────────┘
```

- **Sidebar** (248px, white). The active item is a coral-container pill, the
  same treatment as the app's focused tab. Approvals shows a count badge.
- **Top bar.** Brand switcher on the left, showing name plus category and
  location like the app's `BrandSwitcher`, with "Add a brand" at the bottom
  of the list. On the right: a notification bell with a dropdown of the
  latest 10 and a link to `/notifications`, then an avatar menu (email,
  Settings, Log out).
- **Breakpoints.**
  - 1280px and wider: full sidebar.
  - 768–1279px: 72px icon rail.
  - Below 768px: the sidebar becomes the app's bottom tab bar (Home, Create,
    Analytics, More), so a phone browser feels like the app.
- **Detail panels.** Reviewing a post, an opportunity or a notification opens
  a **right-hand drawer** (480px) over the list rather than a new page.
  This is the main thing a big screen does better than the phone: you work
  through a queue without losing your place.

### 3.3 Component kit

About 20 small components on Tailwind. No component library: this is less
work than configuring one.

| App component                            | Web component                                               | Notes                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GradientButton`                         | `Button` (primary gradient / tonal / ghost / danger)        | `loading` and `disabled` states, optional leading/trailing icon                          |
| `Card`                                   | `Card` (+ `light` variant)                                  | Radius 24, shadow instead of a border                                                    |
| `ChipTag`                                | `Chip` (static or selectable)                               | Tone, colours, styles, goals, filters                                                    |
| `Skeleton` / `SkeletonCard`              | `Skeleton`                                                  | Same "shape first" rule                                                                  |
| `AppHeader`                              | `TopBar`                                                    | See 3.2                                                                                  |
| `BrandSwitcher`                          | `BrandSwitcher` (dropdown)                                  |                                                                                          |
| `ScheduleCountdown`                      | `Countdown`                                                 | Port as is: re-derive from the clock every tick, with an "overdue" label                 |
| `RescheduleControl`                      | `Reschedule`                                                | The app's offset buttons plus a native `<input type="datetime-local">` (free on the web) |
| `WebsiteImportCard`                      | `WebsiteImportCard`                                         | Same "show the proposal before writing" rule                                             |
| `BrandKitFields` + `toBrandKitInput`     | `BrandKitForm`                                              | Port the conversion function unchanged                                                   |
| (none)                                   | `Sidebar`, `Tabs`, `Drawer`, `Modal`, `Toast`, `EmptyState` | Web-only structure                                                                       |
| trends page `ScoreBar`                   | `ScoreBar`                                                  | Move out of the trends page into `components/`                                           |
| analytics `StatTile`, `DeltaPill`, gauge | `StatTile`, `DeltaPill`, `Gauge` (SVG), `Sparkline` (SVG)   | Hand-written SVG, no chart library                                                       |
| (none)                                   | `Dropzone`                                                  | Drag and drop, paste, or pick a product photo                                            |

---

## 4. Sitemap

API paths below are relative to `/api` on content-api (`C`) or geo-api (`G`).

### Public

| Route                                                    | Page                                                                                                     | Work                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `/welcome`                                               | Landing: hero, three feature blocks taken from the app's welcome carousel and app tour, Log in / Sign up | New                                   |
| `/login`                                                 | "Welcome back": split layout, gradient brand panel on the left, form on the right                        | Restyle                               |
| `/signup`                                                | "Join the Pulse": name, email, password (8+) → `/onboarding`                                             | New, plus an `/api/auth/signup` route |
| `/forgot-password`                                       | Email → `C POST /auth/forgot-password`                                                                   | New                                   |
| `/reset-password`                                        | Email + code + new password → `C POST /auth/reset-password`, then log in                                 | New                                   |
| `/privacy`, `/data-deletion`, `/auth/instagram/callback` | Unchanged                                                                                                | Keep                                  |

### Signed in (route group `(app)`, rendered inside the shell)

| Route                                             | Page                                          | Mirrors app screen                                         |
| ------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `/onboarding`                                     | Build your identity (first brand)             | `onboarding/business-setup`, `app-tour`                    |
| `/`                                               | Home                                          | `(tabs)/index`                                             |
| `/create`                                         | Create (image or video)                       | `(tabs)/create`                                            |
| `/create/[jobId]`                                 | Generating → Results                          | `campaign/generating`, `campaign/gallery`, `campaign/post` |
| `/create/video/[jobId]`                           | Video generating → result                     | `campaign/generating-video`, `campaign/video-post`         |
| `/library`                                        | Library (Images / Videos tabs)                | `campaign/history`, `campaign/video-history`               |
| `/approvals`                                      | Your queue (+ review drawer)                  | `approvals/index`, `schedule/review/[postId]`              |
| `/plan`                                           | Marketing plan + steering chat                | `plan/index`, `plan/chat`                                  |
| `/campaigns`, `/campaigns/new`, `/campaigns/[id]` | Auto-campaigns                                | `schedule/*`                                               |
| `/research/trends`, `/research/trends/[runId]`    | Trend research                                | `trends/*`, `opportunities/index`                          |
| `/research/intelligence`                          | Intelligence feed                             | `intelligence/index`                                       |
| `/research/ask`                                   | Ask AI                                        | `intelligence/ask`                                         |
| `/analytics`                                      | Social / AI Visibility tabs                   | `(tabs)/analytics`                                         |
| `/reviews`                                        | Google reviews                                | `google/reviews`                                           |
| `/brand`                                          | Brand Brain (4 tabs)                          | `brand/brain`                                              |
| `/brand/context`                                  | Brand context editor                          | `brand/context`                                            |
| `/brand/kit`                                      | Brand kit + website import                    | `brand/[id]`                                               |
| `/brands/new`                                     | Add a brand                                   | `brand/new`                                                |
| `/notifications`                                  | Notification history                          | `notification-history`                                     |
| `/settings`                                       | Account, connections, autopilot, billing stub | `(tabs)/profile`                                           |

---

## 5. Pages

Each page lists its desktop layout, what's on it, and the endpoints it uses.
Every brand-scoped page refetches when the active brand changes.

### 5.1 Home `/`

The app's Home, spread across two columns.

```
┌───────────────────────────────────────────────┬───────────────────────────┐
│ Good morning, Dhruv                           │  MARKETING AUTOPILOT  ◉ ON │
│ Here's what's ready for you today.            │  Last research  3h ago    │
│                                               │  Next research  in 7h     │
│ ┌─ NEEDS YOU ─────────────────────────────┐   │  [ Turn off ]             │
│ │ ● PRIORITY OPPORTUNITY  Navratri sale…  │   ├───────────────────────────┤
│ │   Post awaiting review · Diwali promo   │   │  PERFORMANCE HUB          │
│ │   Plan item · "Reel: behind the loom"   │   │  Reach 12.4K  ▲ 8%        │
│ │   [ Review all → ]                      │   │  Eng. rate 4.2%  ▲ 0.3    │
│ └─────────────────────────────────────────┘   │  ~~~~~~ sparkline         │
│                                               ├───────────────────────────┤
│ [✦ Create New Promo] [↻ Auto-Campaign] [▦ …]  │  NEED A SPARK?            │
│                                               │  ↗ Find Trending Ideas    │
│ Recent Creations                    See all → │  ◎ Intelligence           │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐            │  ? Ask AI                 │
│ └────┘ └────┘ └────┘ └────┘ └────┘            │                           │
│ Recent Videos & Reels               See all → │                           │
└───────────────────────────────────────────────┴───────────────────────────┘
```

- **Needs you** comes from `C GET /brands/:id/inbox`. Items are sorted by
  urgency. Each kind goes somewhere different: `plan_item` → `/plan`,
  `scheduled_post` → approvals drawer, `opportunity` →
  `/research/trends/[runId]`, `directive_reply` → the `/plan` chat. This is
  the same routing the app's Home uses.
- **Autopilot:** `C GET` / `PATCH /brands/:id/automation-settings` (`contentAutomationEnabled`).
- **Performance:** `C GET /social/accounts`, then `/social/accounts/:id/performance`.
  With no account connected, show a "Connect Instagram" card instead.
- **Recent:** `C GET /generations?brandId&limit=10` and `C GET /video-generations?brandId&limit=10`.

### 5.2 Create `/create`

The app's four steps as one page: the form on the left, a sticky summary and
preview on the right. Structured intake only, with no free-form prompt box
(FR-2.1).

```
┌─────────────────────────────────────────┬───────────────────────────────┐
│ STEP 1: UPLOAD PRODUCT                  │  YOUR CAMPAIGN                │
│ ┌ drop photos here, paste, or browse ┐  │  ┌─────────────┐              │
│ └────────────────────────────────────┘  │  │  photo       │  Instagram  │
│ STEP 2: DETAILS                         │  │  preview     │  post 1:1   │
│ Product name / Brief description        │  └─────────────┘              │
│ Campaign objective  (offer|launch|…)    │  Style: Minimal luxury        │
│ Headline · Offer · CTA (optional)       │  2 variants                   │
│ STEP 3: FORMAT  [1:1] [9:16 Reel] [FB] [A4] │                           │
│ STEP 3B: VIDEO TYPE (Reel only)         │  [ ✦ Generate ]  ← gradient   │
│   Cinematic b-roll · Advertisement      │                               │
│ STEP 4: CHOOSE STYLE                    │                               │
│ Works for anything:  ▢ ▢ ▢ ▢ ▢ ▢ ▢      │                               │
│ Suits certain products: ▢ ▢ ▢ ▢ ▢       │                               │
└─────────────────────────────────────────┴───────────────────────────────┘
```

- Style cards use the same two groups as the app ("Works for anything" /
  "Suits certain products"). The labels and the `styleTemplateSchema` values
  both come from `@bmas/shared`.
- `?opportunity=<id>` prefills the form from a trend idea and shows the app's
  banner: "Prefilled from a trending idea — edit anything below."
- Submitting does:
  1. `C POST /brands/:id/products`
  2. `C POST /brands/:id/products/:productId/images` for each photo (base64, 12 MB cap checked in the browser)
  3. `C POST /generations` or `C POST /video-generations`, with an `Idempotency-Key` header
  4. Navigate to the result page

### 5.3 Generating → Results `/create/[jobId]`

A single page that changes state as the job progresses.

- **Running.** Stage stepper (copy → brief → image → QA) and elapsed time,
  plus the app's reassurance cards ("Smart Palettes", "Momentum Built-in").
  Poll `C GET /generations/:id` every 3s. Cancel with `C POST /generations/:id/cancel`.
- **Succeeded.** A grid of variants, each showing:
  - its variant kind (trend or website)
  - a "Text may be misspelled" warning chip when QA flagged it
  - Download, Regenerate, and Let's post buttons
  - Regenerate opens a modal asking "What would you like to change?" and calls `C POST /generations/:id/assets/:assetId/regenerate`
  - Below the grid, the copy pack (caption, hashtags, platform copy) with Copy buttons
- **Failed.** The error message, plus Try again (a new idempotency key) and Edit request.
- **Let's post** opens a drawer:
  - caption editor, prefilled with caption and hashtags
  - account picker from `C GET /social/accounts`
  - posts with `C POST /social/post`
  - with no account connected, shows "Connect Instagram"

**Video** (`/create/video/[jobId]`) follows the same pattern: poll
`C GET /video-generations/:id`, play the result in a `<video>` element, and
post with `C POST /social/post-reel`. Publishing a Reel can take up to 120s
while Instagram processes it, so show a patient progress state and don't
time out early.

### 5.4 Library `/library`

- Tabs: Images | Videos. Grid of cards showing thumbnail, product, style label, format, status and date.
- Filter by status and format. Clicking a card opens its result page, and a "Re-post" button opens the post drawer.
- Endpoints: `C GET /generations?brandId&limit` and `C GET /video-generations?brandId&limit`.
- Use a paged "Load more" button. The endpoints take a `limit`, so no virtualisation is needed.

### 5.5 Approvals `/approvals`

The app's "Your queue" as three sections: **Waiting for your approval**,
**Scheduled to post**, and **Ideas you can make now**. Clicking a post opens
the review drawer.

```
┌ Waiting for your approval (2) ──────────────────────┐ ┌ Review post ────────────┐
│ ▢ [img] Diwali promo · Instagram · in 2h 14m    >   │ │ [ large preview ]       │
│ ▢ [img] Behind the loom · Instagram · tomorrow  >   │ │ Caption  [ editable ]   │
├ Scheduled to post ─────────────────────────────────-┤ │ Post to  @priyasarees   │
│   [img] Weekend offer · Sat 10:00 · approved        │ │ When  [ +1h ][ +1d ][📅]│
├ Ideas you can make now ────────────────────────────-┤ │ [Reject] [Regenerate]   │
│   "Navratri colours of the day" [ Generate this ]   │ │ [   ✓ Approve   ]       │
└─────────────────────────────────────────────────────┘ └─────────────────────────┘
```

- Lists: `C GET /scheduled-posts?brandId&status=…`. Ideas come from the inbox's plan and opportunity items.
- Drawer: `C GET` / `PATCH /scheduled-posts/:id` (caption, time), plus `POST …/approve`, `…/reject` and `…/regenerate`.
- Optional web extra: checkboxes and "Approve selected", which just loops the approve call. No new endpoint needed.

### 5.6 Plan `/plan`

On the phone these are two screens. On the web they sit side by side: the
plan on the left, the steering chat on the right.

```
┌ Your plan · next 14 days ─────────────────────┬ Tell the platform what you want ─┐
│ WHAT THIS IS BASED ON                         │  you: focus on Navratri, skip    │
│ goals · 3 trends · competitor moves · GEO 42  │       discounts                  │
│                                               │  ◎ researching Navratri 2026…    │
│ Waiting for you                               │  ✓ New plan ready — 2 changes    │
│ ┌ Reel · "9 colours of Navratri" ──────────┐  │                                  │
│ │ why: festival in 6 days, fits pillar…    │  │                                  │
│ │ [ Approve ] [ Swap idea ] [ Skip ]       │  │                                  │
│ └──────────────────────────────────────────┘  │                                  │
│ Already decided  (approved / skipped)         │  [ type a message…        ] [→]  │
│ [ ↻ Refresh plan ]   Plan history ▾           │                                  │
└───────────────────────────────────────────────┴──────────────────────────────────┘
```

- Plan: `C GET /brands/:id/plan` and `/plan/history`, plus `POST /plan/refresh`.
- Plan items: `C POST /plan-items/:id/approve`, `…/replace` (shown as "Swap idea") and `…/reject`.
- Chat: `C GET` / `POST /brands/:id/plan/directives`. Poll every 3s while a
  directive is in progress, showing its stage text ("researching the 100m
  dash in Delhi…").
- Rule carried over from the app: nothing generates until an item is approved. The UI must never imply otherwise.

### 5.7 Campaigns `/campaigns`

- **List:** `C GET /scheduled-campaigns?brandId`. Each card shows status (active, paused, completed), posts done out of total, and the next post countdown.
- **New:** same product/format/style fields as Create, plus Days and Posts per day. Submits with `C POST /brands/:id/scheduled-campaigns`.
- **Detail:** `C GET` / `PATCH /scheduled-campaigns/:id`, pause, resume and delete, with the campaign's posts listed. Each post opens the approvals review drawer.

### 5.8 Research

**Trends** (`/research/trends`, restyled from today's `/trends` page):

- A "Find Trending Content Ideas" button with optional focus and location. Starts a run with `C POST /brands/:id/trend-research`.
- Past runs: `C GET /brands/:id/trend-research`.
- The run page (`/[runId]`) lists opportunity cards ranked by fit. Each card shows:
  - its action tier chip
  - the 6 score bars
  - why it fits
  - Ignore (`PATCH …/opportunities/:oid`), Generate now (links to `/create?opportunity=`), and Schedule for approval (`POST …/opportunities/:oid/schedule`)
- The app's separate Opportunities list becomes a filter on this page.

**Intelligence** (`/research/intelligence`):

- A feed of items with filter chips for category (policy, industry news, local, competitor), and tabs for new / saved / dismissed. The status filter runs in the browser, because the API only filters by category.
- Endpoints: `C GET /brands/:id/intelligence?category`, `GET …/status`, `POST …/runs` for "Refresh my intelligence feed", and `PATCH …/items/:itemId` for save or dismiss.

**Ask AI** (`/research/ask`):

- A prompt box with past questions and answers below it.
- Endpoints: `C POST` / `GET /brands/:id/ai-research`.

### 5.9 Analytics `/analytics`

Two tabs, the same as the app.

**Social** (Instagram):

- Stat tiles with delta pills: reach, engagement rate, total interactions.
- A performance chart.
- Recent posts table: thumbnail, likes, comments, date.
- "What people are saying": the latest comments.
- A Sync now button.
- Endpoints: `C GET /social/accounts/:id/insights`, `/performance`, and `POST /sync`.

**AI Visibility** (GEO):

- Visibility Score shown as a big gauge, plus a history sparkline.
- Visibility by AI Model, one row per engine. Engines that aren't configured show "Not tracked yet" rather than a zero.
- AI Mentions Tracker: excerpts, with sentiment chips.
- AI Search Trends: the tracked prompts, with Keep/Remove, "Probe now", add prompt, and "Suggest prompts".
- Endpoints:
  - `G GET /brands/:id/visibility`, `/visibility/history?days=30`, `/by-engine`, `/mentions`
  - `G GET` / `POST /prompts`, `DELETE /prompts/:id`, `POST /prompts/:id/probe`, `POST /prompts/refresh`

### 5.10 Brand Brain `/brand`

Port the app's four-tab "mission control" layout, and port
`demo-frontend/lib/brandBrain.ts` almost verbatim (it's React-free by design).

- **Overview:** understanding score _with_ the facets it adds up from, how
  much each gap would add ("+20% if you add competitors"), autopilot and
  pipeline state, and an activity timeline.
- **Knowledge:** brand kit, context, competitors, products, each with its source and an Edit link.
- **Research:** freshness of trends and intelligence, plus opportunity counts.
- **Learning:** preferences learned from approvals, rejections and post
  performance. Where none exist it says so honestly ("Progress toward the
  first learning"), with no invented insights.
- Endpoints: `C GET /brands/:id/context`, `/context/snapshots`, `/preferences`,
  `/preferences/:type/history`, `/automation-settings`, and the intelligence
  and trend reads above.

Two editing pages hang off the Brand Brain:

- **`/brand/context`** covers industry, location, audience, positioning,
  goals and pillars (as tap-to-add chips), competitors (with a "Find
  competitors" button calling `POST /context/competitors/discover`) and
  notes. Uses `C PATCH /brands/:id/context` and `POST /context/refresh`.
- **`/brand/kit`** is the brand kit form plus the website import card.
  - Brand: `C PATCH /brands/:id` and `DELETE /brands/:id`, behind a "type the name" confirmation.
  - Website import: `C POST /brands/:id/site-profile/import`, `GET`, `POST …/apply` and `DELETE`.

### 5.11 Onboarding `/onboarding` and `/brands/new`

- **"Build your identity" form:**
  - Business name, industry, location
  - Tone (chips) and colours (swatches, max 3)
  - Languages, platforms, target audience, topics to avoid
  - Website import card at the top: "Read my website and fill this in"
- **Endpoints:** `C POST /brands`, then the site-profile calls.
- **Tour:** a three-step tour modal replaces the app tour, shown once (localStorage flag).
- **Add a brand:** `/brands/new` reuses the same form.

### 5.12 Reviews `/reviews`

- **Not connected:** "Connect Google Business Profile". It opens the URL from
  `C GET /google/auth/url` in a new tab, because the backend's callback
  renders a "you can close this tab" page. The list refetches when the
  window regains focus.
- **Connected:** review list with stars, text, date, and the AI reply with
  its status. Data from `C GET /google/reviews?brandId`.

### 5.13 Notifications `/notifications` + bell

- **Page:** `C GET /notifications?brandId&limit` and `DELETE /notifications/:id`. Each row routes the same way as the app's `notificationTargetHref`.
- **Bell:** polls every 60s, only while the tab is visible.

### 5.14 Settings `/settings`

- **Account:** name and email from `C GET /auth/me`, plus Log out.
- **Connected platforms:**
  - Instagram: connect via `C GET /social/auth/instagram/url`, which uses the existing `/auth/instagram/callback`; disconnect with `DELETE /social/accounts/:id`.
  - Google: same flow as Reviews.
- **Autopilot:** on/off, posting times, research cadence and approval policy, via `C PATCH /brands/:id/automation-settings`. Show its `message` verbatim on a 400, because it explains exactly why.
- **Plan & billing:** the app's honest "Billing isn't set up yet." card and nothing else.

---

## 6. Data and state

- **Fetching:** `contentApi` / `geoApi` in `src/lib/api.ts`. Extend them with
  `put`/`delete` and optional extra headers (for `Idempotency-Key`). Pages are
  client components: the access token only lives in browser memory, so
  server components can't call the API on the user's behalf.
- **Types:** import from `@bmas/shared` wherever the contract lives there
  (plans, scheduling, social, GEO visibility, creatives, video, brand
  context). Response shapes that aren't in shared yet, such as `InboxItem`,
  should be added to `packages/shared`, not copied into the web app. That
  gives both clients one definition.
- **Polling:** one `usePoll(fn, intervalMs, enabled)` hook.
  - 3s for generations, videos, research runs and directives
  - 60s for the bell
  - Stops at a terminal status and while `document.visibilityState` is hidden
- **Active brand:** a `BrandContext` like the app's, persisted in
  localStorage as a per-browser convenience. If the stored id no longer
  exists, fall back to the first brand.
- **Idempotency:** generate `crypto.randomUUID()` once per submit and reuse
  it if that same submit is retried.
- **Uploads:** `<input type="file" accept="image/*">` plus drag-and-drop and
  paste, read with `FileReader` into base64. Reject files over 12 MB before
  uploading.
- **No state library.** Plain `fetch` + `useEffect` + `usePoll`, the same as
  the app and the current trends page. Add TanStack Query only if manual
  refetching after mutations starts to hurt.

---

## 7. Config changes this needs

1. **CSP (`next.config.ts`). This bug already exists:**
   - `img-src 'self' data: blob:` blocks every generated image, because assets are presigned URLs on the storage origin. The current `/trends` thumbnails are affected already.
   - Add the storage public origin (`S3_PUBLIC_URL`, or the R2 public host in prod) to `img-src` and `media-src` (videos).
   - Add the Instagram CDN (`https://*.cdninstagram.com https://*.fbcdn.net`) for post thumbnails.
   - Add `https://lh3.googleusercontent.com` for reviewer avatars.
2. **CORS:** content-api and geo-api `CORS_ORIGINS` must include the web
   origin. Locally that's `http://localhost:3000`, already present. In prod
   it's `https://web.3-24-200-83.sslip.io`.
3. **`/api/auth/signup` route handler:** a copy of `login/route.ts`. Signup
   returns tokens too, so the refresh token has to go into the cookie the
   same way. Reset-password returns `{ ok }`, so it can call content-api
   directly.
4. **`proxy.ts` matcher:** add `welcome|signup|forgot-password|reset-password`
   to the public list, and send signed-out visitors to `/welcome` instead of
   `/login`.
5. **Env:** `NEXT_PUBLIC_*` values are baked in at build time, so the box needs `apps/web/.env.production` with the prod API URLs before `pnpm build`.

---

## 8. Build order

Each phase ends with `pnpm format:check && pnpm typecheck && pnpm lint &&
pnpm build` and a check in the browser.

- [ ] **Phase 0: Foundation.**
  - Tokens and fonts
  - Shell: sidebar, top bar, mobile tab bar
  - Component kit
  - `BrandContext` and `usePoll`
  - CSP/CORS fixes, signup route, `proxy.ts` matcher
  - Delete the placeholders
- [ ] **Phase 1: Core loop.** Home, Create → Results → Post, video result, Library, Approvals and the review drawer.
- [ ] **Phase 2: Brand.**
  - Signup and onboarding (with website import)
  - Brand Brain (port `brandBrain.ts`)
  - Context and Kit editors, Add a brand
  - Settings (connections, autopilot)
- [ ] **Phase 3: Strategy.** Plan and chat, Campaigns, Trends (restyle), Intelligence, Ask AI.
- [ ] **Phase 4: Insights and polish.** Analytics (both tabs), Reviews, Notifications and the bell, `/welcome` landing, forgot/reset password, a responsive pass at 375 / 768 / 1280 px.

## 9. Later, not v1

- Dark mode (token swap)
- Web push
- Keyboard shortcuts for the approvals queue
- Billing, once a payments backend exists
- Social sign-in
- More platforms

## 10. Decisions to confirm

1. **Landing page at `/welcome`?** Planned as a simple one. If this site is
   only for existing users, drop it and keep `/login` as the entry point.
2. **Icons:** `lucide-react` (planned) vs. Material Symbols for exact parity with the app.
3. **Where the web app lives:** `apps/web` in this monorepo, which gives
   shared types and the existing deploy. The alternative is running the Expo
   app on the web via `react-native-web` (already a dependency there). That
   is cheaper up front, but it gives a stretched phone UI rather than a
   desktop layout, and it keeps the hand-copied types.
