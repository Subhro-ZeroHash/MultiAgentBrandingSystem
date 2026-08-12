import { type NextRequest } from 'next/server';

/**
 * Public read-through to an asset's bytes.
 *
 * Exists because Instagram downloads the image from its own servers when
 * publishing, and everything else that serves images here — presigned storage
 * URLs, the API itself — is bound to a private address. This route sits on the
 * one origin that is publicly reachable in development (the tunnel fronting
 * this app) and forwards to content-api, which holds the storage credentials
 * and verifies the signature travelling in the query string.
 *
 * Nothing is validated here: this is a pipe, and content-api is the authority
 * on whether a link is signed, unexpired, and points at a real asset.
 */

// Signed, expiring, and never the same twice — caching it would be wrong.
export const dynamic = 'force-dynamic';

const CONTENT_API_URL =
  process.env.CONTENT_API_URL ?? process.env.NEXT_PUBLIC_CONTENT_API_URL ?? 'http://localhost:4000';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
): Promise<Response> {
  const { assetId } = await params;
  const query = request.nextUrl.searchParams.toString();

  const upstream = await fetch(
    `${CONTENT_API_URL}/api/assets/${encodeURIComponent(assetId)}/raw?${query}`,
    { cache: 'no-store' },
  ).catch(() => null);

  if (!upstream) {
    return new Response('Asset service unavailable', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text().catch(() => 'Asset unavailable'), {
      status: upstream.status,
    });
  }

  // Streamed rather than buffered: these are multi-hundred-KB images and this
  // process has no reason to hold one in memory.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      ...(upstream.headers.get('content-length')
        ? { 'Content-Length': upstream.headers.get('content-length') as string }
        : {}),
      'Cache-Control': 'private, max-age=60',
    },
  });
}
