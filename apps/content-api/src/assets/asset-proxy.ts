import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed links to individual assets, for consumers that fetch the
 * image from their own servers.
 *
 * Instagram is the reason this exists: publishing hands Meta a URL and Meta
 * downloads it, so a presigned URL pointing at private storage cannot work.
 * The image therefore has to be served from an address the public internet can
 * reach, which in development is the tunnel already fronting the web app.
 *
 * Signed rather than simply public, because that tunnel is reachable by anyone
 * who knows the hostname. Without a signature the route would serve any asset
 * id to any caller for as long as the tunnel is up; with one, a link exposes a
 * single asset for a few minutes.
 */

/** Long enough for Meta to fetch and transcode, short enough that a link found
 *  later in a log is already dead. */
export const ASSET_LINK_TTL_SECONDS = 15 * 60;

/**
 * The signing key is derived from ENCRYPTION_KEY rather than being its own
 * secret: one value to configure, and deriving per purpose keeps this key
 * independent of the one protecting stored tokens.
 */
function signingKey(encryptionKey: string): Buffer {
  return createHmac('sha256', encryptionKey).update('asset-proxy-v1').digest();
}

/**
 * Renditions a link may ask for. `raw` serves the stored bytes; `ig` reshapes
 * them to something Instagram will accept (see `instagram-image.ts`).
 *
 * Part of the signed material rather than a free query parameter, so a link
 * authorises one rendition of one asset and nothing else.
 */
export type AssetVariant = 'raw' | 'ig';

function signature(
  assetId: string,
  expiresAt: number,
  variant: AssetVariant,
  encryptionKey: string,
): string {
  return createHmac('sha256', signingKey(encryptionKey))
    .update(`${assetId}.${expiresAt}.${variant}`)
    .digest('hex');
}

export interface AssetLink {
  url: string;
  expiresAt: number;
}

/**
 * Builds the absolute, publicly-fetchable URL for one asset.
 *
 * The path is the web app's proxy route (`apps/web/src/app/api/asset/[assetId]`),
 * not content-api's own `/api/assets/:id/raw` — deliberately, because the public
 * origin in development is the tunnel fronting the web app, and content-api is
 * bound to a private address Meta cannot reach. The proxy forwards the query
 * string untouched, so the signature and variant survive the hop.
 */
export function buildAssetLink(
  baseUrl: string,
  assetId: string,
  encryptionKey: string,
  options: { ttlSeconds?: number; variant?: AssetVariant } = {},
): AssetLink {
  const { ttlSeconds = ASSET_LINK_TTL_SECONDS, variant = 'raw' } = options;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const params = new URLSearchParams({
    exp: String(expiresAt),
    sig: signature(assetId, expiresAt, variant, encryptionKey),
    ...(variant === 'raw' ? {} : { v: variant }),
  });

  return {
    url: `${baseUrl.replace(/\/+$/, '')}/api/asset/${assetId}?${params.toString()}`,
    expiresAt,
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'expired' | 'invalid' };

export function verifyAssetLink(
  assetId: string,
  exp: string | undefined,
  sig: string | undefined,
  encryptionKey: string,
  variant: AssetVariant = 'raw',
): VerifyResult {
  if (!exp || !sig) return { ok: false, reason: 'invalid' };

  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'invalid' };

  const expected = signature(assetId, expiresAt, variant, encryptionKey);
  const provided = Buffer.from(sig, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  // Length must match before timingSafeEqual, which throws on a mismatch.
  if (provided.length !== expectedBuffer.length) return { ok: false, reason: 'invalid' };
  if (!timingSafeEqual(provided, expectedBuffer)) return { ok: false, reason: 'invalid' };

  // Checked after the signature so an attacker cannot use the expiry response
  // to learn that they guessed a valid one.
  if (expiresAt < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

  return { ok: true };
}
