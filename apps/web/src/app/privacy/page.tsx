/**
 * Public — excluded from proxy.ts's auth gate. Meta's App Review and any
 * visitor must be able to load this without a session.
 *
 * Every statement here is meant to be true of the code, not aspirational: the
 * retention and deletion promises are implemented in SocialService.
 * disconnectAccount (deletes Instagram notifications with the account) and
 * instagram-insights-sync (deletes them after 30 days). Change the code and
 * this page together.
 */
import type { ReactNode } from 'react';

export const metadata = { title: 'Privacy Policy — MarketPulse' };

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">
        {n}. {title}
      </h2>
      <div className="space-y-2 text-[var(--color-muted)]">{children}</div>
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

export default function PrivacyPolicyPage() {
  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Last updated October 2, 2026</p>
      </div>

      <p className="text-[var(--color-muted)]">
        MarketPulse is operated by Nirvanta Technologies Inc. (&quot;we&quot;, &quot;us&quot;). This
        policy covers the MarketPulse website and app and the accounts you connect to them: what we
        collect, why, who we share it with, how long we keep it, and how to have it removed.
      </p>

      <Section n={1} title="Information you give us">
        <List>
          <li>Your account: name, email address and password (stored only as a one-way hash).</li>
          <li>
            Your brands: brand details (name, colours, tone, audience, location, goals), products
            and product photos, your instructions for content, and any website you ask us to import.
          </li>
          <li>
            Your activity: the posters, videos, captions, plans and campaigns we generate for you,
            and your approvals, edits and rejections, which we use to learn your preferences.
          </li>
        </List>
      </Section>

      <Section n={2} title="Information from accounts you connect">
        <p>
          <strong className="font-medium text-[var(--color-ink)]">Instagram</strong> (Business or
          Creator accounts):
        </p>
        <List>
          <li>Your profile: username, account type and account ID.</li>
          <li>
            Your posts: caption, media type, timestamp, likes and comment counts, and performance
            metrics (reach, impressions, saves, followers) where you have granted that permission.
          </li>
          <li>Comments on your posts, including the username of the person who commented.</li>
          <li>
            Direct messages sent to your account and replies sent from it, including the
            sender&apos;s Instagram ID and username, where you have granted message permissions.
          </li>
          <li>The access token Instagram issues so we can act on your behalf.</li>
        </List>
        <p>
          Comments and messages come from people who interact with your account. We process them on
          your behalf, only to provide the features described in this policy.
        </p>
        <p>
          <strong className="font-medium text-[var(--color-ink)]">Google Business Profile</strong>,
          if you connect it: your business profile, customer reviews (reviewer name, rating and
          text) and the access token Google issues.
        </p>
        <p>
          <strong className="font-medium text-[var(--color-ink)]">Your device</strong>: if you use
          the phone app, a push notification token so we can alert you.
        </p>
      </Section>

      <Section n={3} title="How we use information">
        <List>
          <li>To create content, plans and campaigns for your brand.</li>
          <li>
            To publish posts and Reels to Instagram: only when you ask, or when you have approved a
            scheduled post.
          </li>
          <li>To show you analytics for your posts and account.</li>
          <li>
            With the Instagram Inbox: to show your comments and messages in one place, suggest
            replies, and send the replies you approve. Replies are sent automatically only for the
            kinds of message you allow in your reply settings; complaints and refund requests always
            wait for a person.
          </li>
          <li>To draft replies to your Google reviews.</li>
          <li>To learn your preferences from your approvals and edits, so future content fits.</li>
          <li>
            To run the service: sign-in, password-reset emails, notifications, security and fixing
            problems.
          </li>
        </List>
        <p>We don&apos;t sell your data, use it for advertising, or use it to train AI models.</p>
      </Section>

      <Section n={4} title="AI providers and other service providers">
        <p>We use these AI providers, which process data only to return results to us:</p>
        <List>
          <li>Google (Gemini): writing, images, video and reply drafts.</li>
          <li>LTX (Lightricks): video.</li>
          <li>
            Tavily: web search for trend and market research. Searches describe your market (for
            example your product category and city), not you.
          </li>
        </List>
        <p>What we send them:</p>
        <List>
          <li>
            To create content: your brand details, product descriptions and photos, your
            instructions, and content from a website you imported.
          </li>
          <li>
            To draft a reply: the comment, message or review being answered, earlier messages in
            that conversation, and your brand details. This happens only when you use the Instagram
            Inbox or Google review replies.
          </li>
          <li>
            Never sent: your access tokens, your post performance metrics, or comments we hold only
            for analytics.
          </li>
        </List>
        <p>
          To run MarketPulse we also use Amazon Web Services (servers, in Australia), Supabase
          (database), Cloudflare (storage for images and videos), Brevo (email) and Expo (phone
          notifications). They store or process data on our behalf, only to provide the service.
        </p>
      </Section>

      <Section n={5} title="How we protect information">
        <List>
          <li>All traffic is encrypted with HTTPS.</li>
          <li>
            Instagram and Google access tokens are encrypted in our database (AES-256-GCM) and are
            never logged.
          </li>
          <li>Passwords are stored only as bcrypt hashes.</li>
          <li>A brand&apos;s data is visible only to the account that owns it.</li>
          <li>Notifications from Instagram are accepted only with a valid signature from Meta.</li>
          <li>Generated images and videos are shared through signed links that expire.</li>
        </List>
      </Section>

      <Section n={6} title="How long we keep data">
        <List>
          <li>
            Your account, brands, generated content and learned preferences: until you delete them
            or your account.
          </li>
          <li>
            Data from a connected Instagram or Google account (the token, post metrics, synced
            comments and reviews): until you disconnect that account.
          </li>
          <li>
            Instagram&apos;s notifications of new comments and messages: deleted automatically after
            30 days.
          </li>
          <li>
            Conversations and replies in the Instagram Inbox: kept while the account stays
            connected, so you keep your history; deleted when you disconnect.
          </li>
          <li>
            Server logs, which can include account names and error details but never message text,
            passwords or tokens: kept only as long as needed to run and fix the service.
          </li>
        </List>
        <p>
          Our database provider keeps routine backups. Data you delete is removed from our database
          straight away, and can remain in those backups for a limited time until they expire.
        </p>
      </Section>

      <Section n={7} title="Disconnecting and deleting your data">
        <List>
          <li>
            <strong className="font-medium text-[var(--color-ink)]">Disconnect Instagram</strong> in
            MarketPulse&apos;s settings. This immediately deletes from our database the access
            token, post metrics, synced comments, and stored comment and message notifications for
            that account. Posts you already published stay on Instagram.
          </li>
          <li>
            <strong className="font-medium text-[var(--color-ink)]">Remove our access</strong> on
            Instagram&apos;s side at any time, under Settings → Apps and websites.
          </li>
          <li>
            <strong className="font-medium text-[var(--color-ink)]">
              Delete your whole account
            </strong>{' '}
            by following the steps on our{' '}
            <a href="/data-deletion" className="underline">
              Data Deletion page
            </a>
            . We delete your account, brands, connected accounts and generated content within 30
            days.
          </li>
        </List>
      </Section>

      <Section n={8} title="Your rights">
        <p>You can ask us to:</p>
        <List>
          <li>give you a copy of the personal data we hold about you;</li>
          <li>correct data that is wrong (most of it you can also edit yourself in the app);</li>
          <li>delete your data or your account;</li>
          <li>stop processing data from a connected account, by disconnecting it.</li>
        </List>
        <p>
          Email{' '}
          <a href="mailto:privacy@nirvanta.co" className="underline">
            privacy@nirvanta.co
          </a>{' '}
          from the address on your account and we&apos;ll respond within 30 days. You can also
          complain to the data protection authority where you live.
        </p>
      </Section>

      <Section n={9} title="Children">
        <p>
          MarketPulse is a tool for businesses and the people who run them. It isn&apos;t directed
          at children, and we don&apos;t knowingly collect personal information from anyone under
          13. If we learn that we have, we delete it.
        </p>
      </Section>

      <Section n={10} title="Changes to this policy">
        <p>
          If this policy changes materially, we&apos;ll update the date above and, where required,
          tell you directly.
        </p>
      </Section>

      <Section n={11} title="Contact">
        <p>
          Nirvanta Technologies Inc. — questions about this policy or your data:{' '}
          <a href="mailto:privacy@nirvanta.co" className="underline">
            privacy@nirvanta.co
          </a>
        </p>
      </Section>
    </div>
  );
}
