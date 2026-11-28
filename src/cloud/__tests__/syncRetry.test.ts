import { describe, expect, it } from 'vitest';
import { syncRetryDelay } from '../syncRetry';
describe('bounded sync retries',()=>{
  it('backs off for transient network failures and stops after four attempts',()=>{
    expect([0,1,2,3,4].map(n=>syncRetryDelay({message:'Failed to fetch'},n))).toEqual([2000,4000,8000,16000,null]);
    expect(syncRetryDelay({code:'PGRST002'},0)).toBe(2000);
    expect(syncRetryDelay({code:'PT429'},0)).toBe(2000);
  });
  it('does not retry deterministic conflicts, permissions or unknown failures',()=>{
    for (const code of ['PT409','40001','42501','23505','23503','22023','PGRST202']) expect(syncRetryDelay({code},0)).toBeNull();
    expect(syncRetryDelay(new Error('Missing workout version'),0)).toBeNull();
  });
});
