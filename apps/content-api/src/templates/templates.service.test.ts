import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { Database } from '@bmas/db';
import { TemplatesService } from './templates.service.js';

describe('TemplatesService', () => {
  it('lists all templates ordered by createdAt desc', async () => {
    const mockRows = [
      { id: 'tpl-1', title: 'Template 1', createdAt: new Date() },
      { id: 'tpl-2', title: 'Template 2', createdAt: new Date() },
    ];
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue(mockRows),
    };

    const service = new TemplatesService(mockDb as unknown as Database);
    const result = await service.list();

    expect(result).toEqual(mockRows);
    expect(mockDb.select).toHaveBeenCalled();
  });

  it('returns a single template by id', async () => {
    const mockRow = { id: 'tpl-1', title: 'Template 1' };
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([mockRow]),
    };

    const service = new TemplatesService(mockDb as unknown as Database);
    const result = await service.getById('tpl-1');

    expect(result).toEqual(mockRow);
  });

  it('throws NotFoundException when template does not exist', async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };

    const service = new TemplatesService(mockDb as unknown as Database);
    await expect(service.getById('non-existent')).rejects.toThrow(NotFoundException);
  });
});
