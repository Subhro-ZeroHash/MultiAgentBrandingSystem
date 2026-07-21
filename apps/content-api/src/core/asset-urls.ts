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

export interface AssetUrls {
  sign(storageKey: string): Promise<string>;
  /** Signs many keys concurrently; signing is local crypto, not a network call. */
  signAll<T extends { storageKey: string }>(rows: T[]): Promise<Array<T & { url: string }>>;
}

export function createAssetUrls(config: AssetUrlConfig): AssetUrls {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.publicEndpoint ?? config.endpoint
      ? { endpoint: config.publicEndpoint ?? config.endpoint }
      : {}),
  });

  const sign = (storageKey: string): Promise<string> =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }), {
      expiresIn: config.expiresInSeconds,
    });

  return {
    sign,
    async signAll(rows) {
      return Promise.all(rows.map(async (row) => ({ ...row, url: await sign(row.storageKey) })));
    },
  };
}
