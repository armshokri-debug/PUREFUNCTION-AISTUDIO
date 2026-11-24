import { describe, expect, it } from 'vitest';
import { isVersionConflictCode } from '../versionConflict';

describe('optimistic conflict codes', () => {
  it('recognizes PostgREST PT409 without interpreting it as a retriable serialization fault', () => {
    expect(isVersionConflictCode('PT409')).toBe(true);
    expect(isVersionConflictCode('40001')).toBe(true); // compatibility with pre-migration data
  });

  it('does not classify unrelated SQL errors as version conflicts', () => {
    for (const code of ['42501','22023','23505','PGRST202',null,undefined,'']) {
      expect(isVersionConflictCode(code)).toBe(false);
    }
  });
});
