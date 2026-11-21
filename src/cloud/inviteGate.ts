// Store only a local UI gate, never the signed invite token or password.
// Session storage prevents an unfinished invite from blocking unrelated tabs.
export const INVITE_PENDING_KEY = 'pf.auth.invite.pending.v1';
type GateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function store(): GateStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}
export function hasPendingInvite(storage: GateStorage | null = store()): boolean {
  try { return storage?.getItem(INVITE_PENDING_KEY) === '1'; }
  catch { return false; }
}
export function markPendingInvite(storage: GateStorage | null = store()): void {
  try { storage?.setItem(INVITE_PENDING_KEY, '1'); }
  catch { /* UI state is also kept in memory. */ }
}
export function clearPendingInvite(storage: GateStorage | null = store()): void {
  try { storage?.removeItem(INVITE_PENDING_KEY); }
  catch { /* UI state is also kept in memory. */ }
}
