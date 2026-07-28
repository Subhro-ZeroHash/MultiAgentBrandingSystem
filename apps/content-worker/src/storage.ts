import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * S3-compatible object storage for generated creatives.
 *
 * Deliberately the plainest possible surface — put, get, url. Object storage is
 * listed as an unbuilt gap in CLAUDE.md, so this is the minimum the image stage
 * needs rather than a considered storage layer; keeping it small is what makes
 * it cheap to replace once that decision is made.
 *
 * Local dev points at the MinIO container; deployed environments point at
 * Cloudflare R2 or S3. Nothing here knows which.
 */

export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO serves buckets as a path segment, not a subdomain. */
  forcePathStyle: boolean;
  /** Base URL for building publicly reachable asset links. */
  publicUrl?: string;
}

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  urlFor(key: string): string;
  /** Creates the bucket when missing. Dev convenience: a fresh MinIO volume has
   *  no buckets, and the first upload would otherwise fail with NoSuchBucket. */
  ensureBucket(): Promise<void>;
}

export function createStorage(config: StorageConfig): Storage {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });

  return {
    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
        } catch (error) {
          // Two workers booting together race here; losing the race is fine.
          const name = (error as { name?: string }).name;
          if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
        }
      }
    },

    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return key;
    },

    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (!result.Body) throw new Error(`Object ${key} has no body`);
      return Buffer.from(await result.Body.transformToByteArray());
    },

    urlFor(key) {
      const base = config.publicUrl ?? `${config.endpoint ?? ''}/${config.bucket}`;
      return `${base.replace(/\/$/, '')}/${key}`;
    },
  };
}

/** Keys are grouped by brand then job so a brand's assets can be listed, and a
 *  failed job's output identified, with a prefix scan alone.
 *
 *  `round` separates a QA regeneration from the variant it replaces. Without it
 *  the retry writes to the same key, destroying the original — which the job
 *  still needs, because a regeneration that also fails falls back to it. */
export function creativeKey(
  brandId: string,
  jobId: string,
  index: number,
  ext = 'png',
  round = 0,
): string {
  const suffix = round > 0 ? `-r${round}` : '';
  return `brands/${brandId}/generations/${jobId}/variant-${index}${suffix}.${ext}`;
}

/** Derived from the full-size key so the pair is always adjacent in the bucket
 *  and a thumbnail can never be orphaned from the variant it belongs to. */
export function thumbnailKey(storageKey: string): string {
  return `${storageKey.replace(/\.[a-z0-9]+$/i, '')}-thumb.jpg`;
}
