/**
 * Public — excluded from proxy.ts's auth gate. Meta's App Review and any
 * visitor must be able to load this without a session.
 */
export const metadata = { title: 'Privacy Policy — MarketPulse' };

export default function PrivacyPolicyPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Last updated August 31, 2026</p>
      </div>

      <p className="text-[var(--color-muted)]">
        MarketPulse is operated by Nirvanta Technologies Inc. (&quot;we&quot;, &quot;us&quot;).
        This policy explains what we collect when you connect an Instagram account, why, and how
        to have it removed.
      </p>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">What we collect from Instagram</h2>
        <ul className="list-disc space-y-1 pl-5 text-[var(--color-muted)]">
          <li>Your Instagram Business/Creator profile — username, account type, profile picture.</li>
          <li>
            Posts and media on the connected account, so we can show performance history: caption,
            media type, timestamp, and public counts (likes, comments).
          </li>
          <li>
            Account-level performance metrics (reach, impressions, follower count, engagement)
            where you&apos;ve granted the insights permission.
          </li>
          <li>
            The access token Instagram issues when you connect your account, so we can act on your
            behalf for the features below.
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">What we use it for</h2>
        <ul className="list-disc space-y-1 pl-5 text-[var(--color-muted)]">
          <li>Publishing a post or Reel to your connected account, only when you ask us to.</li>
          <li>Showing you performance and engagement analytics for content on that account.</li>
          <li>
            Informing the content and campaign suggestions our AI generates for your brand — your
            Instagram data is never used to train a model or shared with another customer.
          </li>
        </ul>
        <p className="text-[var(--color-muted)]">
          Generating content also sends the brand and product details you provide (not your
          Instagram data) to our AI providers — currently Google (Gemini) and LTX.io — solely to
          produce that content.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">How it&apos;s protected</h2>
        <p className="text-[var(--color-muted)]">
          Your Instagram access token is encrypted at rest (AES-256-GCM) in our database — it is
          never stored or logged in plain text. We don&apos;t sell your data, and we don&apos;t
          share it with third parties except the infrastructure and AI providers named above,
          strictly to operate the service.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Deleting your data</h2>
        <p className="text-[var(--color-muted)]">
          Disconnecting your Instagram account from within the app immediately and permanently
          deletes your stored access token and every insight or comment we&apos;d read through
          that connection. See our{' '}
          <a href="/data-deletion" className="underline">
            Data Deletion page
          </a>{' '}
          for how to remove your account entirely.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Children&apos;s privacy</h2>
        <p className="text-[var(--color-muted)]">
          MarketPulse is a business tool and is not directed at, or knowingly used by, anyone
          under 13.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Changes to this policy</h2>
        <p className="text-[var(--color-muted)]">
          If this policy changes materially, we&apos;ll update the date above and, where required,
          notify connected accounts directly.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Contact</h2>
        <p className="text-[var(--color-muted)]">
          Questions about this policy or your data:{' '}
          <a href="mailto:privacy@nirvanta.co" className="underline">
            privacy@nirvanta.co
          </a>
        </p>
      </section>
    </div>
  );
}
