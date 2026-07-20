import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          Brand Marketing Multi-Agent System
        </h1>
        <p className="max-w-2xl text-[var(--color-muted)]">
          Two systems on one Brand Kit: a Creative Content Agent that turns product photos into
          publish-ready creative, and a GEO tracker that measures how AI assistants describe the
          business.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/studio"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-alt)] p-5 transition hover:border-[var(--color-accent)]"
        >
          <h2 className="font-medium">Studio</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Brand Kit, products, and creative generation.
          </p>
        </Link>

        <Link
          href="/geo"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-alt)] p-5 transition hover:border-[var(--color-accent)]"
        >
          <h2 className="font-medium">GEO</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Tracked prompts, engine answers, and visibility scores.
          </p>
        </Link>
      </div>
    </div>
  );
}
