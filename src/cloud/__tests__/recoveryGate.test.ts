import { describe, expect, it } from 'vitest';
import {
  RECOVERY_PENDING_KEY,
  clearPendingRecovery,
  hasPendingRecovery,
  markPendingRecovery
} from '../recoveryGate';

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

describe('auth recovery gate persistence', () => {
  it('blocks regular workspace access across simulated reloads until explicitly cleared', () => {
    const storage = fakeStorage();
    expect(hasPendingRecovery(storage)).toBe(false);
    markPendingRecovery(storage);
    expect(storage.getItem(RECOVERY_PENDING_KEY)).toBe('1');
    expect(hasPendingRecovery(storage)).toBe(true);
    // Reload / a new tab sees the same localStorage marker; no password or token is stored.
    expect(hasPendingRecovery(storage)).toBe(true);
    clearPendingRecovery(storage);
    expect(hasPendingRecovery(storage)).toBe(false);
  });

  it('handles browsers with storage unavailable without throwing', () => {
    const denied = {
      getItem: (_: string): string | null => { throw new Error('denied'); },
      setItem: (_: string, __: string): void => { throw new Error('denied'); },
      removeItem: (_: string): void => { throw new Error('denied'); }
    };
    expect(hasPendingRecovery(denied)).toBe(false);
    expect(() => markPendingRecovery(denied)).not.toThrow();
    expect(() => clearPendingRecovery(denied)).not.toThrow();
  });
});
