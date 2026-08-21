/**
 * True once a stored OAuth token has passed its expiry.
 *
 * Both content-api's publish flow (SocialService.postToInstagram) and
 * content-worker's insights sync need this exact check before touching a
 * stored token, and both flip the account to `token_expired` on it — kept as
 * one shared predicate so the condition itself can't drift between the two
 * independent call sites the way it would if each defined its own.
 */
export function isTokenExpired(tokenExpiresAt: Date, now: Date = new Date()): boolean {
  return tokenExpiresAt.getTime() <= now.getTime();
}

/**
 * Meta returns two different error shapes across the Instagram hosts callers
 * talk to: graph.instagram.com nests it under `error`, while
 * api.instagram.com's OAuth endpoint returns `error_message` at the top
 * level. Reading only the first shape reduced "Invalid platform app" — the
 * message that says the app id is wrong — to a bare "HTTP 400".
 *
 * Shared between content-api's SocialService (which talks to both hosts) and
 * content-worker's Instagram insights sync (which only talks to
 * graph.instagram.com) so the parsing itself can't drift between them the way
 * two independent copies would.
 */
export interface GraphErrorResponse {
  error?: { message?: string; type?: string; code?: number };
  error_message?: string;
  error_type?: string;
  error_description?: string;
}

/** Pulls the actionable detail out of whichever error shape came back; the
 *  bare status ("Bad Request") tells the caller nothing about what to fix. */
export function graphErrorMessage(body: unknown, fallback: string): string {
  const error = body as GraphErrorResponse | null;
  return error?.error?.message ?? error?.error_message ?? error?.error_description ?? fallback;
}

/** True when the payload reports a failure, whatever the HTTP status says. */
export function isGraphErrorPayload(body: unknown): boolean {
  const error = body as GraphErrorResponse | null;
  return Boolean(error?.error ?? error?.error_message ?? error?.error_type);
}
