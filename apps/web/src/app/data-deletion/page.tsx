/**
 * Public — excluded from proxy.ts's auth gate, and linked from the Instagram
 * app's "Data Deletion Instructions URL" setting. Meta requires either this
 * or an automated callback endpoint; a real, unattended request-inbox is a
 * bigger, separate build (see the comment on the contact-email section
 * below), so this is the instructions-URL path Meta's own docs treat as an
 * equally valid alternative.
 */
export const metadata = { title: 'Data Deletion — MarketPulse' };

export default function DataDeletionPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Deleting Your Data</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Disconnect Instagram</h2>
        <p className="text-[var(--color-muted)]">
          Open MarketPulse, go to your connected accounts, and disconnect Instagram. This
          immediately and permanently deletes your stored access token and every post insight or
          comment we&apos;d read through that connection — nothing is kept.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Delete your whole MarketPulse account</h2>
        <p className="text-[var(--color-muted)]">
          Email{' '}
          <a href="mailto:privacy@nirvanta.co?subject=Delete%20my%20account" className="underline">
            privacy@nirvanta.co
          </a>{' '}
          from the address your account is registered under, with the subject &quot;Delete my
          account&quot;. We&apos;ll confirm your identity and permanently delete your account,
          connected social accounts, brands, and generated content within 30 days, and reply once
          it&apos;s done.
        </p>
      </section>
    </div>
  );
}
