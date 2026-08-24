import { describe, expect, it } from 'vitest';
import { dropStaleResults } from './search.js';

describe('dropStaleResults', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  const at = (publishedAt: string | null) => ({
    url: 'https://example.com',
    title: 't',
    snippet: 's',
    publishedAt,
  });

  /**
   * `recencyDays` is only a request to a provider. SerpApi sent no time filter
   * at all until it was given one, and Tavily returns rows months outside its
   * own `days` window — which is how a search for festivals "in the next 30
   * days" surfaced a seven-month-old Republic Day sale as current.
   */
  it('drops results published before the window', () => {
    const kept = dropStaleResults([at('2026-01-09T00:00:00Z'), at('2026-08-20T00:00:00Z')], 45, now);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.publishedAt).toBe('2026-08-20T00:00:00Z');
  });

  /** Absence of a date is not evidence of age, and dropping undated rows
   *  would silently discard providers that do not date their results. */
  it('keeps undated results', () => {
    expect(dropStaleResults([at(null)], 45, now)).toHaveLength(1);
  });

  it('keeps an unparseable date rather than guessing', () => {
    expect(dropStaleResults([at('not a date')], 45, now)).toHaveLength(1);
  });

  it('is a no-op when the caller asked for no window', () => {
    expect(dropStaleResults([at('2020-01-01T00:00:00Z')], undefined, now)).toHaveLength(1);
  });
});
