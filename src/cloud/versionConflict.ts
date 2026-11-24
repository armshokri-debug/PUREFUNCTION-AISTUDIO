/** Business-level optimistic version mismatch. Never retry a stale write blindly.
 * PT409 is HTTP 409 from PostgREST; retain 40001 for older clients/local errors.
 */
export function isVersionConflictCode(code: unknown): boolean {
  return code === 'PT409' || code === '40001';
}
