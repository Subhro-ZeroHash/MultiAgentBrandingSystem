/**
 * GEO surface. Owned by the GEO workstream — see .github/CODEOWNERS.
 */
export default function GeoPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">GEO</h1>
      <p className="max-w-2xl text-[var(--color-muted)]">
        Tracked prompts, per-engine answers, and the visibility score over time.
      </p>
      <p className="text-sm text-[var(--color-muted)]">
        Backend: <code>@bmas/geo-api</code> · queues <code>geo-probe</code>, <code>geo-rollup</code>
      </p>
    </div>
  );
}
