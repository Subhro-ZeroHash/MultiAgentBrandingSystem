import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { geminiSafeSchema } from './gemini.llm.js';

describe('geminiSafeSchema', () => {
  it('drops the ±MAX_SAFE_INTEGER bounds Zod adds to .int(), keeps real ones', () => {
    const schema = z.toJSONSchema(
      z.object({
        any: z.number().int(),
        idx: z.number().int().min(0),
        day: z.number().int().max(13),
      }),
    );
    const safe = JSON.stringify(geminiSafeSchema(schema));
    expect(JSON.stringify(schema)).toContain(String(Number.MAX_SAFE_INTEGER));
    expect(safe).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(safe).toContain('"minimum":0');
    expect(safe).toContain('"maximum":13');
  });
});
