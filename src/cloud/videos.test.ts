import { beforeEach, describe, expect, it, vi } from 'vitest';

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));

vi.mock('./supabase', () => ({
  supabase: { storage: { from: () => ({ remove }) } }
}));

import { deleteExerciseVideo } from './videos';

describe('deleteExerciseVideo', () => {
  const path = 'coach-id/exercise-id/video.mp4';

  beforeEach(() => remove.mockReset());

  it('succeeds only when the requested object is returned as removed', async () => {
    remove.mockResolvedValue({ data: [{ name: path }], error: null });
    await expect(deleteExerciseVideo(path)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith([path]);
  });

  it('propagates Storage permission errors', async () => {
    remove.mockResolvedValue({ data: null, error: new Error('Not authorized') });
    await expect(deleteExerciseVideo(path)).rejects.toThrow('Not authorized');
  });

  it('does not report success when Storage removed nothing', async () => {
    remove.mockResolvedValue({ data: [], error: null });
    await expect(deleteExerciseVideo(path)).rejects.toThrow('Video was not removed');
  });
});
