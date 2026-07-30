import { assertPublicHost } from './net-guard.js';

/**
 * Fetches a brand's homepage and the stylesheets it links, under hard caps.
 *
 * Every bound here exists because the far end is a stranger's server: it may be
 * slow, enormous, or a redirect chain that never terminates. A generation
 * request can afford two minutes; this is a person waiting on an onboarding
 * screen, so the whole budget is 20 seconds and a breach fails cleanly rather
 * than holding the request open.
 */

/** Total wall-clock for the document and every stylesheet together. */
const TOTAL_BUDGET_MS = 20_000;
const DOCUMENT_TIMEOUT_MS = 12_000;
const STYLESHEET_TIMEOUT_MS = 5_000;

const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 1024 * 1024;
/** Enough to catch a theme file plus a couple of component sheets. Beyond that
 *  the marginal colour is noise, and each one costs latency the user feels. */
const MAX_STYLESHEETS = 4;
const MAX_REDIRECTS = 4;

/** Identifies the fetcher honestly. Some CDNs serve a challenge page to a
 *  blank or scripted UA, which reads back as an empty document. */
const USER_AGENT =
  'BMASBrandImporter/1.0 (+brand-kit import; contact your BMAS administrator)';

export interface FetchedSite {
  /** After redirects — relative URLs resolve against this, not the input. */
  finalUrl: string;
  html: string;
  stylesheets: string[];
}

export class SiteUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteUnreachableError';
  }
}

/** Reads a body with a ceiling, so a huge or endless response cannot exhaust
 *  memory. `content-length` is consulted first but not trusted — it is absent
 *  on chunked responses and can simply be wrong. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) {
    throw new SiteUnreachableError('That page is too large to import.');
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) {
        // Take what we have rather than failing: a partial homepage still
        // carries the head, the palette and enough copy to read a brand from.
        chunks.push(value);
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * One hop. Validates the host, fetches without following redirects, and
 * returns either the response or the next URL to try.
 *
 * Redirects are followed by hand because `redirect: 'follow'` would resolve
 * later hops without ever showing them to the guard — a public URL that
 * 302s to `http://169.254.169.254` is exactly the bypass this prevents.
 */
async function fetchOnce(
  url: URL,
  timeoutMs: number,
  deadline: number,
  accept: string,
): Promise<{ response: Response } | { redirectTo: URL }> {
  await assertPublicHost(url.hostname);

  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SiteUnreachableError('Timed out reading that website.');

  const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining));
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept,
        'accept-language': 'en',
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SiteUnreachableError(`Could not reach ${url.hostname} — ${reason}`);
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new SiteUnreachableError('That URL redirected without a destination.');

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new SiteUnreachableError('That URL redirected somewhere unreadable.');
    }
    if (!/^https?:$/.test(next.protocol)) {
      throw new SiteUnreachableError('That URL redirected to an unsupported protocol.');
    }
    return { redirectTo: next };
  }

  return { response };
}

async function fetchFollowing(
  start: URL,
  timeoutMs: number,
  deadline: number,
  accept: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(current, timeoutMs, deadline, accept);
    if ('response' in result) return { response: result.response, finalUrl: current };
    current = result.redirectTo;
  }

  throw new SiteUnreachableError('That URL redirected too many times.');
}

/** Stylesheet hrefs from `<link rel="stylesheet">`, resolved against the page.
 *  Cross-origin sheets are kept — a Google Fonts or CDN-hosted theme file is
 *  often where the palette actually lives — but each is guarded like any other
 *  fetch. */
function stylesheetUrls(html: string, base: URL): URL[] {
  const urls: URL[] = [];
  const linkTag = /<link\b[^>]*>/gi;

  for (const [tag] of html.matchAll(linkTag)) {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;

    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!value) continue;

    try {
      const resolved = new URL(value, base);
      if (/^https?:$/.test(resolved.protocol)) urls.push(resolved);
    } catch {
      // A malformed href is the page's problem, not ours.
    }
  }

  return urls.slice(0, MAX_STYLESHEETS);
}

/**
 * Fetches the document and its stylesheets. A stylesheet that fails is skipped
 * rather than fatal — the inline `<style>` blocks and the page itself still
 * carry most of what the extractor needs.
 */
export async function fetchSite(rawUrl: string): Promise<FetchedSite> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  let start: URL;
  try {
    start = new URL(rawUrl);
  } catch {
    throw new SiteUnreachableError('That does not look like a valid web address.');
  }
  if (!/^https?:$/.test(start.protocol)) {
    throw new SiteUnreachableError('Only http and https addresses can be imported.');
  }

  const { response, finalUrl } = await fetchFollowing(
    start,
    DOCUMENT_TIMEOUT_MS,
    deadline,
    'text/html,application/xhtml+xml',
  );

  if (!response.ok) {
    throw new SiteUnreachableError(
      `That website returned ${response.status} ${response.statusText}. Check the address is correct and publicly reachable.`,
    );
  }

  const html = await readCapped(response, MAX_HTML_BYTES);

  const stylesheets: string[] = [];
  for (const href of stylesheetUrls(html, finalUrl)) {
    if (Date.now() >= deadline) break;
    try {
      const sheet = await fetchFollowing(href, STYLESHEET_TIMEOUT_MS, deadline, 'text/css');
      if (!sheet.response.ok) continue;
      stylesheets.push(await readCapped(sheet.response, MAX_STYLESHEET_BYTES));
    } catch {
      // Blocked, slow, or gone. The page still stands on its own.
    }
  }

  return { finalUrl: finalUrl.toString(), html, stylesheets };
}
