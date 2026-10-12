import { assertPublicHost } from '../brand-site/net-guard.js';

/**
 * Studio references given as links instead of files: what each link is, and a
 * guarded download for the ones we fetch ourselves.
 */

export type ReferenceLink =
  | { kind: 'youtube'; url: string }
  | { kind: 'fetch'; url: URL }
  | { kind: 'instagram'; shortcode: string }
  | { kind: 'refused'; reason: string };

const SOCIAL_HOSTS =
  /(^|\.)(tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|threads\.net)$/i;

/** What a pasted link is. YouTube goes to Gemini as a link (Google supports
 *  it); an Instagram post is looked up among the user's own posts (the only
 *  media Instagram's API gives out); other social posts are refused (their
 *  terms forbid downloading, and they block it); Drive and Dropbox share links
 *  are turned into their direct-download form; anything else is fetched. */
export function classifyReferenceLink(raw: string): ReferenceLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return {
      kind: 'refused',
      reason: "That doesn't look like a link. Paste the full address, starting with https://.",
    };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { kind: 'refused', reason: 'Only http and https links work.' };
  }
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) {
    const id =
      host === 'youtu.be'
        ? url.pathname.slice(1)
        : (url.searchParams.get('v') ??
          /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(url.pathname)?.[1]);
    return id && /^[\w-]{11}$/.test(id)
      ? { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}` }
      : { kind: 'refused', reason: "That YouTube link doesn't point at a video." };
  }

  if (/(^|\.)instagram\.com$/.test(host)) {
    const shortcode = /^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/.exec(url.pathname)?.[1];
    return shortcode
      ? { kind: 'instagram', shortcode }
      : { kind: 'refused', reason: 'Paste the link of a post or reel, not a profile.' };
  }

  if (SOCIAL_HOSTS.test(host)) {
    return {
      kind: 'refused',
      reason:
        "TikTok, Facebook and X don't allow other apps to download their videos. Save it to your phone and upload the file, or use a YouTube link.",
    };
  }

  const drive = /^\/file\/d\/([\w-]+)/.exec(url.pathname);
  if (host === 'drive.google.com' && drive) {
    return {
      kind: 'fetch',
      url: new URL(`https://drive.google.com/uc?export=download&id=${drive[1]}`),
    };
  }
  if (/(^|\.)dropbox\.com$/.test(host)) url.searchParams.set('dl', '1');
  return { kind: 'fetch', url };
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Downloads a link the user gave, at most `maxBytes`. Redirects are followed
 * by hand so every hop passes the SSRF guard — unlike the website importer's
 * image fetch, the bytes here may be a video, which nothing decodes to prove
 * it isn't an internal service's response.
 */
export async function fetchReferenceLink(start: URL, maxBytes: number): Promise<Buffer> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; MarketPulse/1.0)' },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      if (!/^https?:$/.test(url.protocol))
        throw new Error('The link redirects somewhere we cannot follow.');
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`The link answered ${response.status}.`);
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new TooBigError();

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new TooBigError();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('The link redirects too many times.');
}

export class TooBigError extends Error {}
