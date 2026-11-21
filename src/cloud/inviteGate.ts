const KEY = 'pf.invite.pending';

export function hasPendingInvite(): boolean {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function markPendingInvite(): void {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* private browsing */ }
}
export function clearPendingInvite(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* private browsing */ }
}
