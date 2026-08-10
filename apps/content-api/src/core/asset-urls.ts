import type { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Turns storage keys into URLs a client can actually load.
 *
 * Presigned rather than proxied: the bytes go straight from object storage to
 * the client, so the API never streams image data and the bucket stays private.
 * Object storage is an unbuilt gap in this repo, so this is the minimum the
 * clients need — a CDN in front of the bucket would replace it.
 *
 * The public endpoint is configured separately from the internal one because
 * they genuinely differ: services reach MinIO at `localhost:9000`, but a phone
 * running the Expo app resolves `localhost` to itself. A URL signed for the
 * internal host is unreachable from any real device.
 */
export interface AssetUrlConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Where this process reaches object storage. */
  endpoint?: string;
  /** Where clients reach it. Defaults to `endpoint`. */
  publicEndpoint?: string;
  /** Signed URL lifetime. Long enough to browse a gallery, short enough that a
   *  leaked link is not a permanent one. */
  expiresInSeconds: number;
}

export interface AssetObject {
  body: Readable;
  contentType: string;
  contentLength?: number;
}

export interface AssetUrls {
  sign(storageKey: string): Promise<string>;
  /** Signs many keys concurrently; signing is local crypto, not a network call.
   *  A row carrying `thumbnailStorageKey` also gets a signed `thumbnailUrl`,
   *  falling back to the full-size URL so a client never has to branch. */
  signAll<T extends { storageKey: string; thumbnailStorageKey?: string | null }>(
    rows: T[],
  ): Promise<Array<T & { url: string; thumbnailUrl: string }>>;
  /**
   * Streams an object's bytes through this process.
   *
   * The presigned URLs above are the normal path and stay that way — this
   * exists only for consumers that cannot use them, namely Instagram, which
   * downloads the image from its own servers and so cannot reach a URL signed
   * for a private LAN address.
   */
  read(storageKey: string): Promise<AssetObject>;
}

export function createAssetUrls(config: AssetUrlConfig): AssetUrls {
  // Use publicEndpoint for signing URLs (what clients will access),
  // fall back to internal endpoint if no public endpoint configured
  const urlEndpoint = config.publicEndpoint || config.endpoint;

  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(urlEndpoint ? { endpoint: urlEndpoint } : {}),
  });

  // Signing targets the public host, but fetching bytes is this process talking
  // to storage directly, so it takes the internal route.
  const readClient =
    config.endpoint === urlEndpoint
      ? client
      : new S3Client({
          region: config.region,
          forcePathStyle: config.forcePathStyle,
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
          ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        });

  const sign = (storageKey: string): Promise<string> =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }), {
      expiresIn: config.expiresInSeconds,
    });

  return {
    sign,
    async signAll(rows) {
      return Promise.all(
        rows.map(async (row) => {
          // Older assets predate thumbnailing and rows can carry null when it
          // failed, so the full-size URL is the fallback rather than an error.
          const [url, thumbnailUrl] = await Promise.all([
            sign(row.storageKey),
            sign(row.thumbnailStorageKey ?? row.storageKey),
          ]);
          return { ...row, url, thumbnailUrl };
        }),
      );
    },
    async read(storageKey) {
      const object = await readClient.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }),
      );
      if (!object.Body) throw new Error(`Object ${storageKey} has no body`);

      return {
        body: object.Body as Readable,
        contentType: object.ContentType ?? 'application/octet-stream',
        ...(object.ContentLength === undefined ? {} : { contentLength: object.ContentLength }),
      };
    },
  };
}
