// Keep an in-progress recovery flow across refreshes and other tabs on this device.
// Only the local UI gate is stored here: never store a token or password.
export const RECOVERY_PENDING_KEY = 'pf.auth.recovery.pending.v1';

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function localStore(): RecoveryStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function hasPendingRecovery(storage: RecoveryStorage | null = localStore()): boolean {
  try {
    return storage?.getItem(RECOVERY_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function markPendingRecovery(storage: RecoveryStorage | null = localStore()): void {
  try {
    storage?.setItem(RECOVERY_PENDING_KEY, '1');
  } catch {
    // Storage can be disabled (private mode). In-memory recovery gate still applies.
  }
}

export function clearPendingRecovery(storage: RecoveryStorage | null = localStore()): void {
  try {
    storage?.removeItem(RECOVERY_PENDING_KEY);
  } catch {
    // Safe fallback when storage is unavailable.
  }
}
