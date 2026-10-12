import { describe, expect, it } from 'vitest';
import { friendlyError } from './friendly-error.js';

describe('friendlyError', () => {
  // Real errors from failed jobs in the local database.
  it.each([
    [
      'ltx.poll: job 1acf failed — insufficient_funds_error: Insufficient funds. Required: 78 cents',
      /paused on our side/,
    ],
    [
      'google.json:volume: {"error":{"code":429,"message":"Your prepayment credits are depleted.',
      /paused on our side/,
    ],
    ['connect ECONNREFUSED ::1:9000 (ECONNREFUSED)', /couldn't reach/],
    ['ltx.submit: fetch failed ← Connect Timeout Error (attempted addresses: …)', /couldn't reach/],
    ['stalled: exceeded run timeout, presumed crashed', /took too long/],
    ['veo: the prompt was blocked by Responsible AI practices', /declined this one/],
    ['google: 429 RESOURCE_EXHAUSTED, retry in 20s', /busy right now/],
    ['Product 1234 not found', /has been deleted/],
    ['Gemini returned an unusable shot plan: ...', /Something went wrong/],
  ])('%s', (raw, expected) => {
    expect(friendlyError(raw)).toMatch(expected);
  });

  it('passes a missing error through', () => {
    expect(friendlyError(null)).toBeNull();
  });
});
