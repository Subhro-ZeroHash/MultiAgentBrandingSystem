'use client';

/**
 * Trend Opportunity Engine surface. Owned by the content workstream — see
 * .github/CODEOWNERS.
 *
 * The first interactive page in this app — Studio and GEO are still
 * placeholders — so this also establishes the pattern the next real page
 * will likely copy: `contentApi` from `src/lib/api.ts` for fetches, an
 * `x-user-id: dev-user` header (matches `DEV_OWNER_ID` on content-api; no
 * auth exists yet, see CLAUDE.md's "deliberate gaps"), and 3s polling while
 * a run is in flight (the same cadence generations.controller.ts's own
 * comment describes for the create screen).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AutomationSettings, TrendActionTier, TrendOpportunity, TrendResearchRun } from '@bmas/shared';
import { contentApi, ApiError } from '@/lib/api';

const DEV_HEADERS = { 'x-user-id': 'dev-user' };
const RUN_POLL_MS = 3000;

interface BrandSummary {
  id: string;
  name: string;
}

interface GenerationJobStatus {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  assets: Array<{ url?: string; thumbnailUrl?: string | null }>;
}

const ACTION_TIER_STYLE: Record<TrendActionTier, string> = {
  immediate_action: 'bg-red-600/15 text-red-600 dark:text-red-400',
  recommended: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
  monitor: 'bg-yellow-600/15 text-yellow-700 dark:text-yellow-400',
  ignore: 'bg-[var(--color-line)] text-[var(--color-muted)]',
};

const ACTION_TIER_LABEL: Record<TrendActionTier, string> = {
  immediate_action: 'Immediate Action',
  recommended: 'Recommended',
  monitor: 'Monitor',
  ignore: 'Ignore',
};

/** The 6 axes shown per opportunity — `overall`/`marketingPotential` are
 *  relabeled "Opportunity Score"/"Content Potential" here for the reasons
 *  documented in trends.ts; no extra fields exist beyond what's already on
 *  `score`. */
const SCORE_ROWS: Array<{ key: keyof TrendOpportunity['score']; label: string }> = [
  { key: 'trendScore', label: 'Trend Score' },
  { key: 'brandRelevance', label: 'Brand Relevance' },
  { key: 'productRelevance', label: 'Product Relevance' },
  { key: 'audienceRelevance', label: 'Audience Relevance' },
  { key: 'urgency', label: 'Urgency' },
  { key: 'marketingPotential', label: 'Content Potential' },
];

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 shrink-0 text-[var(--color-muted)]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-line)]">
        <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 shrink-0 text-right tabular-nums">{value}</span>
    </div>
  );
}

function RecommendedContent({ jobRefs }: { jobRefs: TrendOpportunity['generationJobIds'] }) {
  const [jobs, setJobs] = useState<Record<string, GenerationJobStatus>>({});

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      for (const ref of jobRefs) {
        try {
          const job = await contentApi.get<GenerationJobStatus>(`/generations/${ref.jobId}`, DEV_HEADERS);
          if (!cancelled) setJobs((prev) => ({ ...prev, [ref.jobId]: job }));
        } catch {
          // A single job's poll failing shouldn't blank out the others.
        }
      }
    };
    void poll();
    const stillInFlight = jobRefs.some((ref) => {
      const status = jobs[ref.jobId]?.status;
      return status === undefined || status === 'queued' || status === 'running';
    });
    if (!stillInFlight) return;
    const interval = setInterval(poll, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Deliberately keyed on jobRefs alone, not `jobs` — this should poll
    // until every job settles, not restart its interval on every poll tick.
  }, [jobRefs]);

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--color-line)] pt-3">
      <p className="text-xs font-medium text-[var(--color-muted)]">Recommended Content</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {jobRefs.map((ref) => {
          const job = jobs[ref.jobId];
          const thumbnail = job?.assets[0]?.thumbnailUrl ?? job?.assets[0]?.url;
          return (
            <div key={ref.jobId} className="rounded-md border border-[var(--color-line)] p-2 text-xs">
              <p className="font-medium">{ref.label}</p>
              <p className="text-[var(--color-muted)]">{ref.outputFormat}</p>
              {thumbnail ? (
                <img src={thumbnail} alt={ref.label} className="mt-2 aspect-square w-full rounded object-cover" />
              ) : (
                <p className="mt-2 text-[var(--color-muted)]">{job?.status ?? 'queued'}…</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OpportunityCard({ opportunity }: { opportunity: TrendOpportunity }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--color-muted)]">{opportunity.topic}</p>
          <h3 className="font-semibold">{opportunity.title}</h3>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${ACTION_TIER_STYLE[opportunity.actionTier]}`}
        >
          {ACTION_TIER_LABEL[opportunity.actionTier]}
        </span>
      </div>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{opportunity.recommendation}</p>

      <div className="mt-3 space-y-1">
        {SCORE_ROWS.map((row) => (
          <ScoreBar key={row.key} label={row.label} value={opportunity.score[row.key] as number} />
        ))}
        <div className="flex items-center gap-2 pt-1 text-sm font-semibold">
          <span className="w-32 shrink-0">Opportunity Score</span>
          <span className="tabular-nums">{opportunity.score.overall}</span>
        </div>
      </div>

      {opportunity.autoTriggered && opportunity.generationJobIds.length > 0 && (
        <RecommendedContent jobRefs={opportunity.generationJobIds} />
      )}
    </div>
  );
}

export default function TrendsPage() {
  const [brands, setBrands] = useState<BrandSummary[]>([]);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [runs, setRuns] = useState<TrendResearchRun[]>([]);
  const [activeRun, setActiveRun] = useState<(TrendResearchRun & { opportunities: TrendOpportunity[] }) | null>(
    null,
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    contentApi
      .get<BrandSummary[]>('/brands', DEV_HEADERS)
      .then((list) => {
        setBrands(list);
        if (list[0]) setBrandId(list[0].id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load brands'));
  }, []);

  const loadSettings = useCallback((id: string) => {
    contentApi
      .get<AutomationSettings>(`/brands/${id}/automation-settings`, DEV_HEADERS)
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const loadRun = useCallback(async (id: string, runId: string) => {
    try {
      const run = await contentApi.get<TrendResearchRun & { opportunities: TrendOpportunity[] }>(
        `/brands/${id}/trend-research/${runId}`,
        DEV_HEADERS,
      );
      setActiveRun(run);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load run');
    }
  }, []);

  const loadRuns = useCallback(
    (id: string) => {
      contentApi
        .get<TrendResearchRun[]>(`/brands/${id}/trend-research`, DEV_HEADERS)
        .then((list) => {
          setRuns(list);
          if (list[0]) void loadRun(id, list[0].id);
          else setActiveRun(null);
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load trend research runs'));
    },
    [loadRun],
  );

  useEffect(() => {
    if (!brandId) return;
    setActiveRun(null);
    loadSettings(brandId);
    loadRuns(brandId);
  }, [brandId, loadSettings, loadRuns]);

  // Poll the active run while it's still working — mirrors the create
  // screen's own polling cadence, per this file's header comment.
  useEffect(() => {
    if (!brandId || !activeRun || activeRun.status !== 'running') return;
    const interval = setInterval(() => void loadRun(brandId, activeRun.id), RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [brandId, activeRun, loadRun]);

  const startResearch = async () => {
    if (!brandId) return;
    setStarting(true);
    setError(null);
    try {
      await contentApi.post(`/brands/${brandId}/trend-research`, {}, DEV_HEADERS);
      loadRuns(brandId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start research');
    } finally {
      setStarting(false);
    }
  };

  /** One handler for every on/off switch in the settings panel below — full
   *  control over whether content keeps flowing, at each stage of the
   *  pipeline independently: research running at all, opportunities
   *  auto-generating content, and generated content auto-publishing. Each
   *  is its own field on the same `automation_settings` row, so flipping
   *  one is a single PATCH; optimistic, rolled back on failure. */
  const toggleSetting = async (field: keyof AutomationSettings) => {
    if (!brandId || !settings) return;
    const current = settings[field];
    if (typeof current !== 'boolean') return;
    const next = !current;
    setSettings({ ...settings, [field]: next });
    try {
      const updated = await contentApi.patch<AutomationSettings>(
        `/brands/${brandId}/automation-settings`,
        { [field]: next },
        DEV_HEADERS,
      );
      setSettings(updated);
    } catch (err) {
      setSettings({ ...settings, [field]: current });
      setError(
        err instanceof ApiError
          ? err.message
          : `Failed to update automation settings`,
      );
    }
  };

  const opportunities = [...(activeRun?.opportunities ?? [])].sort((a, b) => b.score.overall - a.score.overall);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trend Opportunity Engine</h1>
          <p className="max-w-2xl text-sm text-[var(--color-muted)]">
            Scored trend opportunities and, for the highest-scoring ones, the content already
            generated from them.
          </p>
        </div>
        {brands.length > 0 && (
          <select
            value={brandId ?? ''}
            onChange={(event) => setBrandId(event.target.value)}
            className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-red-600/30 bg-red-600/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {brandId && (
        <div className="space-y-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-alt)] p-4">
          <button
            type="button"
            onClick={startResearch}
            disabled={starting || activeRun?.status === 'running'}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {activeRun?.status === 'running' ? 'Researching…' : 'Find Trending Content Ideas'}
          </button>

          {/* Full stop/start control over the pipeline, one switch per
              stage: whether research runs on a schedule at all, whether a
              high-scoring opportunity auto-generates content, and whether
              generated content auto-publishes. Independent switches, not
              one master toggle, so turning off auto-publish (say) doesn't
              also silently stop research from running. */}
          <div className="space-y-2 border-t border-[var(--color-line)] pt-4">
            <p className="text-xs font-medium text-[var(--color-muted)]">
              Automation — turn any stage off at any time to stop content from flowing further
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings?.contentAutomationEnabled ?? false}
                onChange={() => toggleSetting('contentAutomationEnabled')}
                disabled={!settings}
              />
              Run scheduled trend &amp; intelligence research
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings?.autoTriggerHighScoreOpportunities ?? false}
                onChange={() => toggleSetting('autoTriggerHighScoreOpportunities')}
                disabled={!settings}
              />
              Auto-generate content for 92+ opportunities
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings?.autoPublishEnabled ?? false}
                onChange={() => toggleSetting('autoPublishEnabled')}
                disabled={!settings}
              />
              Auto-publish generated posts{' '}
              <span className="text-[var(--color-muted)]">(requires Full Autopilot approval policy)</span>
            </label>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => brandId && void loadRun(brandId, run.id)}
              className={`rounded-full px-3 py-1 text-xs ${
                activeRun?.id === run.id
                  ? 'bg-[var(--color-ink)] text-[var(--color-surface)]'
                  : 'border border-[var(--color-line)] text-[var(--color-muted)]'
              }`}
            >
              {new Date(run.createdAt).toLocaleString()} · {run.status}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {opportunities.length === 0 && activeRun && activeRun.status === 'succeeded' && (
          <p className="text-sm text-[var(--color-muted)]">
            This run found nothing worth surfacing for this brand right now.
          </p>
        )}
        {opportunities.map((opportunity) => (
          <OpportunityCard key={opportunity.id} opportunity={opportunity} />
        ))}
      </div>
    </div>
  );
}
