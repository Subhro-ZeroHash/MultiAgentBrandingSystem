import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { partialForUpdate } from './common.js';
import { updateBrandKitSchema } from './brand.js';
import { updateBrandContextSchema } from './content/brand-context.js';

/**
 * These pin a bug that is invisible at every layer that could catch it.
 *
 * Zod keeps `.default()` through `.partial()`, so a PATCH body that omits a
 * defaulted field arrives at the service holding that field's default. Every
 * update service in the repo is written as `...(input.x ? { x: input.x } : {})`,
 * which cannot distinguish that from a deliberate `[]` — so it writes the empty
 * array over the stored value.
 *
 * Nothing fails: the request validates, the update succeeds, and the response
 * is a well-formed brand that has quietly lost its banned topics. It was found
 * by renaming a brand and watching five columns empty themselves.
 */
describe('partialForUpdate', () => {
  it('leaves an omitted defaulted field undefined instead of filling the default', () => {
    const entity = z.object({
      name: z.string(),
      tags: z.array(z.string()).default([]),
    });

    // The behaviour being guarded against, asserted so this test explains
    // itself if zod ever changes it.
    expect(entity.partial().parse({ name: 'x' })).toEqual({ name: 'x', tags: [] });

    expect(partialForUpdate(entity).parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('still accepts an explicit empty array, which is how a field is cleared', () => {
    const entity = z.object({ tags: z.array(z.string()).default(['a']) });
    expect(partialForUpdate(entity).parse({ tags: [] })).toEqual({ tags: [] });
  });

  it('keeps validating the fields it strips defaults from', () => {
    const entity = z.object({ tags: z.array(z.string()).max(2).default([]) });
    expect(() => partialForUpdate(entity).parse({ tags: ['a', 'b', 'c'] })).toThrow();
  });

  it('does not touch fields that never had a default', () => {
    const entity = z.object({ name: z.string().min(2) });
    expect(() => partialForUpdate(entity).parse({ name: 'x' })).toThrow();
    expect(partialForUpdate(entity).parse({})).toEqual({});
  });
});

describe('update schemas do not fabricate values for omitted fields', () => {
  // The Brand Kit case that surfaced this. `bannedTopics` is the hard
  // constraint the brief and copy prompts enforce, so emptying it on an
  // unrelated edit does not merely lose data — it removes a safety rail.
  it('updateBrandKitSchema: renaming a brand touches nothing else', () => {
    expect(updateBrandKitSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('updateBrandContextSchema: editing notes keeps goals, competitors and pillars', () => {
    expect(updateBrandContextSchema.parse({ notes: 'just a note' })).toEqual({
      notes: 'just a note',
    });
  });

  it('an explicit clear still comes through', () => {
    expect(updateBrandKitSchema.parse({ bannedTopics: [] })).toEqual({ bannedTopics: [] });
  });
});
