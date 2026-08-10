import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ObjectStore } from '../core/object-store.js';
import { assertPublicHost } from './net-guard.js';

/**
 * Copies a brand's logo and a little of its photography into our own bucket.
 *
 * Stored rather than linked for two reasons. The image stage needs *bytes* to
 * pass as conditioning, so a URL would have to be fetched on every generation —
 * against someone else's server, inside a paid job, with no control over
 * whether it still resolves. And a hotlink breaks silently the day the brand
 * redesigns, which would degrade every creative from then on with nothing in
 * the logs to say why.
 *
 * Every fetch here goes through the same SSRF guard as the page itself: these
 * URLs came off a user-supplied document, so they are no more trusted than the
 * URL that produced them.
 */

const ASSET_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 25_000;

/** Generous for a logo, tight enough that a hero image at print resolution does
 *  not land in Postgres-adjacent storage for no reason. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** How many photographs to keep as style reference. Two is enough to establish
 *  a treatment; more crowds the conditioning against the product photo, which
 *  has to stay the dominant reference. */
const MAX_STYLE_REFERENCES = 2;

/** Below this a logo is a favicon, and upscaling one into a creative looks
 *  worse than omitting it. Checked against the longer edge, because a wordmark
 *  is legitimately wide and short. */
const MIN_LOGO_EDGE = 48;

/**
 * Below this an image is not a photograph.
 *
 * Checked against the *shorter* edge, unlike the logo. A 439x126 banner clears
 * any longest-edge test while being a strip of text — which is how a site's
 * header graphic ended up offered to the model as photography to imitate.
 */
const MIN_PHOTO_EDGE = 400;

export interface StoredAsset {
  storageKey: string;
  width: number;
  height: number;
}

interface FetchedBytes {
  data: Buffer;
  mediaType: string;
}

async function fetchAsset(url: string, deadline: number): Promise<FetchedBytes | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;

  try {
    await assertPublicHost(parsed.hostname);
  } catch {
    return null;
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;

  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(Math.min(ASSET_TIMEOUT_MS, remaining)),
      headers: { accept: 'image/*' },
      // Not followed by hand here, unlike the document fetch: an image CDN
      // redirects constantly and each hop would need its own guard pass. The
      // exposure is narrower — the response is decoded by sharp and discarded
      // unless it is a real raster image, so a redirect to an internal service
      // yields bytes that fail to decode rather than a readable response.
      redirect: 'follow',
    });
    if (!response.ok) return null;

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_ASSET_BYTES) return null;

    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_ASSET_BYTES) return null;

    return { data, mediaType: response.headers.get('content-type')?.split(';')[0] ?? '' };
  } catch {
    return null;
  }
}

/**
 * Normalises whatever came back into a PNG the image adapters accept.
 *
 * Re-encoding rather than trusting the declared content type: a server may
 * mislabel, and sharp decoding the bytes is the only real proof this is an
 * image at all. That doubles as the sanitiser for the redirect note above.
 */
async function normalise(
  bytes: FetchedBytes,
  minEdge: number,
  /** 'longest' suits a logo, where a wide short wordmark is normal. 'shortest'
   *  suits a photograph, where a thin strip is a banner rather than a photo. */
  edge: 'longest' | 'shortest',
): Promise<{ data: Buffer; width: number; height: number } | null> {
  try {
    const image = sharp(bytes.data, { failOn: 'none' });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) return null;

    const measured =
      edge === 'longest' ? Math.max(meta.width, meta.height) : Math.min(meta.width, meta.height);
    if (measured < minEdge) return null;

    // SVG has no fixed raster size and sharp rasterises it at its nominal
    // dimensions, which for a logo is frequently tiny. Rendered at a usable
    // size instead so a vector logo is not thrown away by the edge check.
    const data = await image.png().toBuffer();
    const out = await sharp(data).metadata();
    return { data, width: out.width ?? meta.width, height: out.height ?? meta.height };
  } catch {
    return null;
  }
}

export interface FetchBrandAssetsInput {
  brandId: string;
  logoUrl: string | null;
  imageUrls: readonly string[];
  store: ObjectStore;
}

export interface FetchBrandAssetsResult {
  logo: StoredAsset | null;
  styleReferences: StoredAsset[];
}

/** Keyed under the brand so a re-import overwrites rather than accumulates,
 *  and so the layout matches the product-image keys the worker already reads. */
export function brandSiteAssetKey(brandId: string, name: string): string {
  return `brands/${brandId}/site/${name}.png`;
}

/**
 * Best-effort throughout. A brand whose logo 404s still gets a working import —
 * every one of these is enrichment on top of the text analysis, and none of it
 * is worth failing the whole thing for.
 */
export async function fetchBrandAssets(
  input: FetchBrandAssetsInput,
): Promise<FetchBrandAssetsResult> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const { brandId, logoUrl, imageUrls, store } = input;

  /**
   * Content hashes of everything already kept.
   *
   * De-duplicating on bytes rather than on URL because the same asset is
   * routinely served under several URLs — a CDN width parameter, http vs
   * https, a cache buster. A live import hit exactly that: the site's og:image
   * was its logo under a different query string, so the logo was stored twice
   * and reached the model both as "the brand's logo" and as "photography to
   * imitate", which is worse than not passing it at all.
   */
  const seen = new Set<string>();
  const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

  let logo: StoredAsset | null = null;
  if (logoUrl) {
    const bytes = await fetchAsset(logoUrl, deadline);
    const image = bytes && (await normalise(bytes, MIN_LOGO_EDGE, 'longest'));
    if (image) {
      const storageKey = brandSiteAssetKey(brandId, 'logo');
      await store.put(storageKey, image.data, 'image/png');
      logo = { storageKey, width: image.width, height: image.height };
      seen.add(digest(image.data));
    }
  }

  const styleReferences: StoredAsset[] = [];
  for (const [index, url] of imageUrls.entries()) {
    if (styleReferences.length >= MAX_STYLE_REFERENCES) break;
    if (Date.now() >= deadline) break;

    const bytes = await fetchAsset(url, deadline);
    const image = bytes && (await normalise(bytes, MIN_PHOTO_EDGE, 'shortest'));
    if (!image) continue;

    const hash = digest(image.data);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const storageKey = brandSiteAssetKey(brandId, `style-${index}`);
    await store.put(storageKey, image.data, 'image/png');
    styleReferences.push({ storageKey, width: image.width, height: image.height });
  }

  return { logo, styleReferences };
}
