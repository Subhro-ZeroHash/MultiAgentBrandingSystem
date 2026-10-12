/**
 * What a person sees when a generation fails. Workers record errors written
 * for us ("ltx.poll: job … insufficient_funds_error …"), so the API swaps them
 * for a plain sentence on the way out; the raw text stays in the row and in
 * the worker's logs for debugging.
 *
 * Checked in order, so the network rule sits above the refusal rule:
 * "ECONNREFUSED" would otherwise read as the AI refusing the request.
 */
const RULES: Array<[RegExp, string]> = [
  [
    /insufficient.funds|credits? (are )?depleted|prepayment|billing|limit: 0|not installed|not configured/i,
    "Creating is paused on our side right now — it's nothing you did. Please try again later.",
  ],
  [
    /econnrefused|econnreset|enotfound|fetch failed|socket hang up|connect timeout|network/i,
    "We couldn't reach our AI services. Please try again in a few minutes.",
  ],
  [
    /safety|blocked|responsible ai|\brai\b|content polic|prohibited|refus/i,
    'The AI declined this one; it may have flagged the photo or the wording. Try a different photo or description.',
  ],
  [
    /\b429\b|rate.?limit|resource.?exhausted|overloaded|unavailable|\b503\b/i,
    'Our AI services are busy right now. Please try again in a few minutes.',
  ],
  [/stalled|timed? ?out|timeout/i, 'This took too long and was stopped. Please try again.'],
  [
    /product .*(not found|deleted)|was deleted/i,
    'The product this was made from has been deleted.',
  ],
];

const FALLBACK = 'Something went wrong while making this. Please try again.';

export function friendlyError(raw: string | null): string | null {
  if (!raw) return raw;
  return RULES.find(([pattern]) => pattern.test(raw))?.[1] ?? FALLBACK;
}
