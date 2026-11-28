/** Automatic retries are bounded; permanent/unknown errors require an explicit retry.
 * No retry is safe for stale versions, invalid input, or permission failures.
 */
export function syncRetryDelay(error: unknown, attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= 4) return null;
  const e = error as {code?: unknown; status?: unknown; message?: unknown} | null;
  const code = String(e?.code ?? '');
  const status = Number(e?.status);
  const message = String(e?.message ?? '');
  const transient = ['PGRST000','PGRST001','PGRST002','57014','PT429','429','502','503','504'].includes(code)
    || (!code && (status === 0 || status === 429 || status >= 500 || /failed to fetch|network|timeout|load failed/i.test(message)));
  return transient ? 2000 * 2 ** attempt : null;
}
