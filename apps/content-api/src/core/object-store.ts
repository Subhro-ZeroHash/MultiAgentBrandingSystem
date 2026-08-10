import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Write side of object storage for the API — currently just product-image
 * uploads. Reads and presigning live in asset-urls.ts; kept separate so the
 * upload path does not pull in the presigner and vice versa.
 *
 * Object storage is an unbuilt gap in this repo, so this is the minimum the
 * upload route needs. The worker reads these same keys back out of the same
 * bucket (apps/content-worker/src/storage.ts), so the key scheme here and the
 * bucket config must match.
 */
export interface ObjectStoreConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  endpoint?: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
  };
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Grouped by brand then product so a product's photos are a prefix scan, and
 *  the layout mirrors the generated-asset keys the worker writes. */
export function productImageKey(
  brandId: string,
  productId: string,
  imageId: string,
  mediaType: string,
): string {
  const ext = EXT_BY_MEDIA_TYPE[mediaType] ?? 'jpg';
  return `brands/${brandId}/products/${productId}/${imageId}.${ext}`;
}
