/**
 * Where Instagram sends the browser after the consent screen.
 *
 * The code-for-token exchange runs here on the server, not in the browser.
 * Instagram requires an HTTPS redirect URI, so in development this page is
 * reached through a tunnel — and a browser that arrived that way cannot resolve
 * the `localhost:4000` that content-api listens on. Exchanging server-side
 * keeps the whole flow behind a single tunnelled origin, and the authorization
 * code never touches client-side JavaScript.
 */

// Reached only with query parameters, and it must never be cached: an
// authorization code is single-use.
export const dynamic = 'force-dynamic';

const CONTENT_API_URL =
  process.env.CONTENT_API_URL ?? process.env.NEXT_PUBLIC_CONTENT_API_URL ?? 'http://localhost:4000';

interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

async function connect(params: CallbackParams): Promise<{ ok: boolean; message: string }> {
  if (params.error || params.error_description) {
    return { ok: false, message: params.error_description ?? params.error ?? 'Sign-in was cancelled.' };
  }
  if (!params.code || !params.state) {
    return { ok: false, message: 'Instagram did not return an authorization code.' };
  }

  try {
    const response = await fetch(`${CONTENT_API_URL}/api/social/auth/instagram/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: params.code, state: params.state }),
      cache: 'no-store',
    });

    const body = (await response.json().catch(() => null)) as {
      displayName?: string;
      message?: string;
    } | null;

    if (!response.ok) {
      return { ok: false, message: body?.message ?? `Request failed (${response.status})` };
    }
    return {
      ok: true,
      message: `Connected ${body?.displayName ?? 'your account'}. You can close this tab and return to the app.`,
    };
  } catch {
    return { ok: false, message: `Could not reach the API at ${CONTENT_API_URL}. Is content-api running?` };
  }
}

export default async function InstagramCallbackPage({
  searchParams,
}: {
  searchParams: Promise<CallbackParams>;
}) {
  const result = await connect(await searchParams);

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '64px 24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 12 }}>
        {result.ok ? 'Instagram connected' : 'Connection failed'}
      </h1>
      <p style={{ color: '#666', maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
        {result.message}
      </p>
    </main>
  );
}
