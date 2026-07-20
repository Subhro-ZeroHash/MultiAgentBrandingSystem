/**
 * Content-generation surface. Owned by the content workstream — see
 * .github/CODEOWNERS.
 */
export default function StudioPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
      <p className="max-w-2xl text-[var(--color-muted)]">
        Brand Kit setup, product uploads, and the structured creative request form live here.
      </p>
      <p className="text-sm text-[var(--color-muted)]">
        Backend: <code>@bmas/content-api</code> · queue <code>content-generation</code>
      </p>
    </div>
  );
}
