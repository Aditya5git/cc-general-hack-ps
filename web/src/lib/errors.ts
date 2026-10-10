import { UnsafeUrlError } from "./connectors/safe-url";

/** An error whose message is already written for the user and can be shown as-is. */
export class UserFacingError extends Error {}

// First match wins: credits before busy, since a 402 body can also mention quota.
const REASONS: [RegExp, string][] = [
  [/\b402\b|credits|payment required|insufficient (balance|funds)/i, "out of credits"],
  [/\b(429|503|529)\b|rate.?limit|resource.?exhausted|quota|overload|too many requests|unavailable/i, "service busy right now"],
  [/timed? ?out|timeout|aborted/i, "took too long to respond"],
  [/\b(401|403)\b|api.?key|unauthori[sz]ed|forbidden|permission/i, "access refused"],
  [/\b404\b|not found/i, "page not found"],
  [/content-type/i, "not a readable page"],
  [/\b5\d\d\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|unreachable|network|socket|redirect/i, "couldn't be reached"],
];

/**
 * A few plain words on why something failed ("service busy right now"), never the raw provider text: that
 * can hold JSON, URLs and key hints. Log the raw error with console.error where this is used.
 */
export function friendlyReason(e: unknown): string {
  if (e instanceof UserFacingError || e instanceof UnsafeUrlError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return REASONS.find(([re]) => re.test(msg))?.[1] ?? "unexpected error";
}
