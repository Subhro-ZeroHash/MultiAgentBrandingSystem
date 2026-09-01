import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Database } from '@bmas/db';
import { SocialService } from './social.service.js';
import { TokenEncryption } from '@bmas/shared';
import { BadRequestException } from '@nestjs/common';

// assertPublicHost does a real DNS lookup — mocked here so this suite stays
// network-free (same reasoning CLAUDE.md gives for keeping a real Postgres/
// Redis/provider out of it). 'localhost' resolves locally with no network
// dependency, so the rejection test below exercises the real implementation
// instead; only the success-path fixture needs the network call replaced.
vi.mock('../brand-site/net-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../brand-site/net-guard.js')>(
    '../brand-site/net-guard.js',
  );
  return {
    ...actual,
    assertPublicHost: vi.fn(async (hostname: string) => {
      if (hostname === 'public.example.com') return;
      return actual.assertPublicHost(hostname);
    }),
  };
});

/** Loose enough to keep `.mockImplementation` available on every method in
 *  the test bodies below — typing this as `Database` itself hides those
 *  vitest mock members behind Drizzle's real (non-mock) method signatures. */
interface DbMock {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

describe('SocialService - Instagram Posting Logic', () => {
  let dbMock: DbMock;
  let service: SocialService;
  const encryptionKey = '4b1d1fdd56339823ccde56983c3912b621a6de486b3e49b74dcbb0501499e20d';

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://bmas:bmas@localhost:5433/bmas';
    process.env.REDIS_URL = 'redis://localhost:6380';
    process.env.AUTH_SECRET = '33d114cedadea6a5383c45ca8256b9a7aa227cf3fb5abad5b9ee8fb1f8128f4e';
    process.env.PUBLIC_ASSET_BASE_URL = 'https://tunnel.example.com';
    process.env.ENCRYPTION_KEY = encryptionKey;

    dbMock = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    service = new SocialService(dbMock as unknown as Database);
  });

  describe('postToInstagram parameter validation', () => {
    it('throws BadRequestException if neither assetId nor imageUrl is provided', async () => {
      dbMock.select.mockImplementation(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 'acc-1',
                ownerId: 'user-1',
                platform: 'instagram',
                igBusinessId: 'ig-123',
                pageAccessToken: 'token-xyz',
                tokenExpiresAt: new Date(Date.now() + 86400000),
                displayName: '@testaccount',
                status: 'active',
              },
            ],
          }),
        }),
      }));

      await expect(service.postToInstagram('acc-1', 'user-1', {}, 'Test caption')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException if the social account token is expired', async () => {
      let selectCount = 0;
      dbMock.select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: 'acc-1',
                    ownerId: 'user-1',
                    platform: 'instagram',
                    igBusinessId: 'ig-123',
                    pageAccessToken: 'token-xyz',
                    tokenExpiresAt: new Date(Date.now() - 1000),
                    displayName: '@testaccount',
                    status: 'active',
                  },
                ],
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        };
      });

      dbMock.update.mockImplementation(() => ({
        set: () => ({
          where: async () => [],
        }),
      }));

      await expect(
        service.postToInstagram(
          'acc-1',
          'user-1',
          { imageUrl: 'https://public.example.com/img.jpg' },
          'Test caption',
        ),
      ).rejects.toThrow(/expired/i);
    });

    it('throws BadRequestException for non-http or localhost image URLs', async () => {
      let selectCount = 0;
      dbMock.select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: 'acc-1',
                    ownerId: 'user-1',
                    platform: 'instagram',
                    igBusinessId: 'ig-123',
                    pageAccessToken: 'token-xyz',
                    tokenExpiresAt: new Date(Date.now() + 86400000),
                    displayName: '@testaccount',
                    status: 'active',
                  },
                ],
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        };
      });

      await expect(
        service.postToInstagram(
          'acc-1',
          'user-1',
          { imageUrl: 'http://localhost:3000/image.png' },
          'Test caption',
        ),
      ).rejects.toThrow(/publicly reachable/i);
    });
  });

  describe('postToInstagram execution flow', () => {
    it('successfully posts an image to Instagram through Graph API', async () => {
      const encryptor = new TokenEncryption(encryptionKey);
      const encryptedToken = encryptor.encrypt('valid-access-token');

      let selectCount = 0;
      dbMock.select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: 'acc-1',
                    ownerId: 'user-1',
                    platform: 'instagram',
                    igBusinessId: 'ig-123',
                    pageAccessToken: encryptedToken,
                    tokenExpiresAt: new Date(Date.now() + 86400000),
                    displayName: '@testaccount',
                    status: 'active',
                  },
                ],
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        };
      });

      // Mock global fetch for container creation, status polling, and media publishing
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = url.toString();
        // Container creation
        if (
          urlStr.includes('/media') &&
          init?.method === 'POST' &&
          !urlStr.includes('/media_publish')
        ) {
          return new Response(JSON.stringify({ id: 'container-999' }), { status: 200 });
        }
        // Container status poll
        if (urlStr.includes('container-999') && init?.method !== 'POST') {
          return new Response(JSON.stringify({ status_code: 'FINISHED' }), { status: 200 });
        }
        // Publish post
        if (urlStr.includes('/media_publish') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'post-1000' }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const result = await service.postToInstagram(
        'acc-1',
        'user-1',
        { imageUrl: 'https://public.example.com/valid-image.jpg' },
        'Fresh content post!',
      );

      expect(result).toEqual({ postId: 'post-1000', success: true });
      fetchSpy.mockRestore();
    });
  });
});
