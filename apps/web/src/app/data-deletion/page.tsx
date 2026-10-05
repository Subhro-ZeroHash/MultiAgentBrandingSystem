/**
 * Public — excluded from proxy.ts's auth gate, and linked from the Instagram
 * app's "Data Deletion Instructions URL" setting. Meta requires either this
 * or an automated callback endpoint; a real, unattended request-inbox is a
 * bigger, separate build (see the comment on the contact-email section
 * below), so this is the instructions-URL path Meta's own docs treat as an
 * equally valid alternative.
 *
 * Keep in step with section 7 of /privacy and with
 * SocialService.disconnectAccount, which implements the first section.
 */
export const metadata = { title: 'Data Deletion — MarketPulse' };

export default function DataDeletionPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Deleting Your Data</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Disconnect Instagram</h2>
        <p className="text-[var(--color-muted)]">
          Open MarketPulse, go to Settings, and disconnect Instagram. This immediately deletes from
          our database the stored access token, post metrics, synced comments, Instagram Inbox
          conversations, and the comment and message notifications we received for that account.
          Posts you already published stay on Instagram.
        </p>
        <p className="text-[var(--color-muted)]">
          You can also remove our access on Instagram&apos;s side at any time, under Settings → Apps
          and websites.
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
          account&quot;. We&apos;ll confirm your identity and delete your account, connected social
          accounts, brands, and generated content within 30 days, and reply once it&apos;s done.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Backups</h2>
        <p className="text-[var(--color-muted)]">
          Deleted data is removed from our database straight away. Our database provider keeps
          routine backups, and deleted data can remain in them for a limited time until they expire.
        </p>
      </section>
    </div>
  );
}
