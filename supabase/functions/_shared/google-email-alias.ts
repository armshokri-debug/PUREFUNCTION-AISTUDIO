/**
 * Google's gmail.com and googlemail.com domains deliver to the same mailbox.
 * Do not rewrite plus-tags, dots or email addresses from other providers:
 * those transformations can change account identity and invitation matching.
 */
export function alternateGoogleMailDomain(rawEmail: string): string | null {
  const email = rawEmail.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === 'gmail.com') return `${local}@googlemail.com`;
  if (domain === 'googlemail.com') return `${local}@gmail.com`;
  return null;
}

/** Common rate-limit key across the two Google-owned domain spellings. */
export function emailCooldownKey(rawEmail: string): string {
  const email = rawEmail.trim().toLowerCase();
  return email.endsWith('@googlemail.com')
    ? email.slice(0, -'googlemail.com'.length) + 'gmail.com'
    : email;
}

/**
 * Retry only an invalid-password-style sign-in against Google's other domain.
 * A valid exact-address login always wins. Non-Google addresses are untouched.
 * The same password must be supplied by the caller for both attempts.
 */
export async function signInWithGoogleEmailFallback<T extends { error: { message: string } | null }>(
  rawEmail: string,
  attempt: (email: string) => Promise<T>
): Promise<T> {
  const email = rawEmail.trim();
  const first = await attempt(email);
  const alternate = alternateGoogleMailDomain(email);
  if (!alternate || !first.error || !/invalid login credentials/i.test(first.error.message)) {
    return first;
  }
  return attempt(alternate);
}
