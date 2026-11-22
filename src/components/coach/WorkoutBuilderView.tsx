import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GripVertical,
  Link2,
  Plus,
  Search,
  Trash2,
  X,
  AlertTriangle
} from 'lucide-react';
import { ClientProfile, Exercise, Workout, WorkoutBlock } from '../../types';
import type { SyncState } from '../../cloud/useClientsStore';
import { searchExercises, useExerciseLibrary } from '../../state/ExerciseLibrary';
import { MUSCLE_GROUPS, equipmentTypeOf, groupOf } from '../../lib/exerciseSearch';
import { WEIGHT_UNIT, roundLb } from '../../lib/units';
import { ExerciseThumb } from '../ExerciseMedia';
import { ActionDropdown } from './ActionDropdown';
import { WeightInput } from '../WeightInput';
import {
  addDays,
  blankWorkout,
  copyWeek,
  copyWorkouts,
  dayShort,
  defaultBlockFor,
  effectiveStatus,
  formatDate,
  formatPerformance,
  formatWeekRange,
  lastPerformance,
  orderLabels,
  parseISODate,
  removeWorkout,
  resizeSets,
  startOfWeek,
  todayISO,
  upsertWorkout,
  weekDates,
  workoutOn
} from '../../lib/workouts';

interface WorkoutBuilderViewProps {
  clients: ClientProfile[];
  client: ClientProfile;
  onSelectClientId: (id: string) => void;
  onUpdateClient: (updated: ClientProfile) => void;
  syncState?: SyncState;
  onFlush?: () => Promise<boolean>;
}

const card = 'bg-white rounded-2xl shadow-[0_2px_14px_rgba(0,0,0,0.04)] border border-gray-100';
const numInput =
  'w-full bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-base sm:text-sm text-[#111827] tabular-nums focus:outline-none focus:border-[#111827]';
const LIST_LIMIT = 40;

const STATUS_STYLE: Record<Workout['status'], { dot: string; label: string; pill: string }> = {
  planned: { dot: 'bg-gray-300', label: 'Planned', pill: 'bg-gray-100 text-gray-700' },
  completed: { dot: 'bg-[#16A34A]', label: 'Completed', pill: 'bg-[#DCFCE7] text-[#166534]' },
  missed: { dot: 'bg-[#DC2626]', label: 'Missed', pill: 'bg-[#FEE2E2] text-[#991B1B]' }
};

/** Keep draft values editable without persisting an invalid intermediate value. */
const SetsInput: React.FC<{ value: number; onCommit: (n: number) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const text = draft.trim();
    const next = /^\d+$/.test(text) ? Number(text) : NaN;
    if (Number.isInteger(next) && next >= 1 && next <= 20) {
      if (next !== value) onCommit(next);
      setDraft(String(next));
    } else setDraft(String(value));
  };
  return <input aria-label="Sets" type="text" inputMode="numeric" value={draft} className={numInput}
    onChange={(event) => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
};
const RepsInput: React.FC<{ value: string; onCommit: (text: string) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input aria-label="Reps" value={draft} placeholder="8-10" className={numInput}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { if (draft !== value) onCommit(draft); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
};
function savedWorkoutDate(clientId: string, fallback: string): string {
  try {
    const value = sessionStorage.getItem(`pf.workout.date.${clientId}`);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
  } catch { return fallback; }
}

export const WorkoutBuilderView: React.FC<WorkoutBuilderViewProps> = ({
  clients,
  client,
  onSelectClientId,
  onUpdateClient,
  syncState,
  onFlush
}) => {
  const today = todayISO();
  const { exercises, getExercise } = useExerciseLibrary();
  const [selectedDate, setSelectedDate] = useState(() => savedWorkoutDate(client.id, today));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(savedWorkoutDate(client.id, today)));
  useEffect(() => {
    const date = savedWorkoutDate(client.id, todayISO());
    setSelectedDate(date);
    setWeekStart(startOfWeek(date));
  }, [client.id]);
  const selectDate = (date: string) => {
    setSelectedDate(date);
    try { sessionStorage.setItem(`pf.workout.date.${client.id}`, date); } catch { /* storage unavailable */ }
  };
  const [search, setSearch] = useState('');
  const [bodyPart, setBodyPart] = useState('All');
  const [isDragOver, setIsDragOver] = useState(false);
  const [toast, setToast] = useState<{ text: string; warn?: boolean } | null>(null);
  const [copyTo, setCopyTo] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const libraryRef = useRef<HTMLDivElement>(null);
  const latestClientRef = useRef(client);
  latestClientRef.current = client;

  const days = weekDates(weekStart);
  const workout = workoutOn(client, selectedDate);

  const results = useMemo(
    () => searchExercises(exercises, search, { group: bodyPart }),
    [exercises, search, bodyPart]
  );

  const flash = (text: string, warn = false) => {
    setToast({ text, warn });
    window.setTimeout(() => setToast(null), 3500);
  };

  const goWeek = (delta: number) => {
    const ws = addDays(weekStart, delta * 7);
    setWeekStart(ws);
    const dow = (parseISODate(selectedDate).getDay() + 6) % 7;
    selectDate(addDays(ws, dow));
    setConfirmDelete(false);
    setCopyTo(null);
  };

  const goToday = () => {
    setWeekStart(startOfWeek(today));
    selectDate(today);
  };

  /* ---------------- workout edits (saved immediately) ---------------- */

  const commitClient = (next: ClientProfile) => {
    latestClientRef.current = next;
    onUpdateClient(next);
  };

  const saveWorkout = (w: Workout) => commitClient(upsertWorkout(latestClientRef.current, w));

  const patchWorkout = (patch: Partial<Workout>) => {
    const currentWorkout = workoutOn(latestClientRef.current, selectedDate);
    if (currentWorkout) saveWorkout({ ...currentWorkout, ...patch });
  };

  const patchBlock = (blockId: string, patch: Partial<WorkoutBlock>) => {
    const currentWorkout = workoutOn(latestClientRef.current, selectedDate);
    if (!currentWorkout) return;
    saveWorkout({
      ...currentWorkout,
      blocks: currentWorkout.blocks.map((b) => {
        if (b.id !== blockId) return b;
        const next = { ...b, ...patch };
        if (patch.sets !== undefined || patch.loadKg !== undefined) {
          const minLogged = next.loggedSets.reduce(
            (max, s, idx) => (s.completed || s.reps != null ? idx + 1 : max),
            0
          );
          const sets = resizeSets(next.loggedSets, Math.max(next.sets, minLogged), next.loadKg || null);
          next.loggedSets =
            patch.loadKg !== undefined
              ? sets.map((s) => (s.completed ? s : { ...s, kg: next.loadKg || null }))
              : sets;
        }
        return next;
      })
    });
  };

  const addExercise = (exercise: Exercise) => {
    const latestClient = latestClientRef.current;
    const base = workoutOn(latestClient, selectedDate) ?? blankWorkout(selectedDate);
    const block = defaultBlockFor(exercise);
    const prev = lastPerformance(latestClient, exercise.id, selectedDate);
    if (prev) {
      block.reps = prev.reps;
      block.sets = prev.plannedSets;
      block.loadKg = Math.max(...prev.sets.map((s) => s.kg));
      block.loggedSets = resizeSets([], block.sets, block.loadKg || null);
    }
    saveWorkout({ ...base, blocks: [...base.blocks, block] });
    flash(`Added ${exercise.name} to ${formatDate(selectedDate, { weekday: true })}`);
  };

  const moveBlock = (index: number, dir: -1 | 1) => {
    const currentWorkout = workoutOn(latestClientRef.current, selectedDate);
    if (!currentWorkout) return;
    const to = index + dir;
    if (to < 0 || to >= currentWorkout.blocks.length) return;
    const blocks = [...currentWorkout.blocks];
    [blocks[index], blocks[to]] = [blocks[to], blocks[index]];
    if (blocks[0].supersetWithPrevious) blocks[0] = { ...blocks[0], supersetWithPrevious: false };
    saveWorkout({ ...currentWorkout, blocks });
  };

  const removeBlock = (blockId: string) => {
    const currentWorkout = workoutOn(latestClientRef.current, selectedDate);
    if (!currentWorkout) return;
    const blocks = currentWorkout.blocks.filter((b) => b.id !== blockId);
    if (blocks[0]?.supersetWithPrevious) blocks[0] = { ...blocks[0], supersetWithPrevious: false };
    saveWorkout({ ...currentWorkout, blocks });
  };

  const handleCopyWeek = () => {
    const target = addDays(weekStart, 7);
    const r = copyWeek(latestClientRef.current, weekStart, target);
    if (r.copied === 0 && r.skipped === 0) {
      flash('Nothing to copy — this week has no workouts.', true);
      return;
    }
    commitClient(r.client);
    flash(
      `Copied ${r.copied} workout${r.copied === 1 ? '' : 's'} to ${formatWeekRange(target)}` +
        (r.skipped ? ` · ${r.skipped} skipped (already logged)` : ''),
      r.skipped > 0
    );
  };

  const handleCopyDay = () => {
    const currentWorkout = workoutOn(latestClientRef.current, selectedDate);
    if (!currentWorkout || !copyTo) return;
    const r = copyWorkouts(latestClientRef.current, [{ from: currentWorkout, toDate: copyTo }]);
    if (r.skipped) {
      flash(`${formatDate(copyTo, { weekday: true })} already has logged results — not overwritten.`, true);
      return;
    }
    commitClient(r.client);
    flash(`Copied to ${formatDate(copyTo, { weekday: true })}`);
    setCopyTo(null);
  };

  const labels = workout ? orderLabels(workout.blocks) : [];
  const status = workout ? effectiveStatus(workout, today) : null;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-[34px] font-bold tracking-tight text-[#111827] leading-tight">
            Workout Builder
          </h1>
          {clients.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 mt-1.5 text-sm sm:text-base text-gray-500">
            <div className="relative inline-flex items-center">
              <select
                value={client.id}
                onChange={(e) => onSelectClientId(e.target.value)}
                aria-label="Client"
                className="appearance-none bg-transparent pr-5 font-medium text-[#111827] focus:outline-none cursor-pointer"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 text-gray-400 absolute right-0 pointer-events-none" />
            </div>
            <span>·</span>
            <span>
              Phase {client.phaseNumber} ({client.phaseName})
            </span>
            </div>
          )}
        </div>

        <div className="self-start sm:self-auto">
          <ActionDropdown label="Workout actions" items={[
            { label: 'Copy week to next week', onSelect: handleCopyWeek },
            ...(workout ? [
              { label: 'Copy workout to date', onSelect: () => setCopyTo(addDays(selectedDate, 7)) },
              { label: 'Delete workout', onSelect: () => setConfirmDelete(true), destructive: true }
            ] : [])
          ]} />
        </div>
      </div>

      {/* Week navigation */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-1">
          <button onClick={() => goWeek(-1)} aria-label="Previous week" className="p-2 rounded-lg hover:bg-gray-100 cursor-pointer">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="text-sm sm:text-base font-semibold text-[#111827] tabular-nums min-w-[120px] text-center">
            {formatWeekRange(weekStart)}
          </span>
          <button onClick={() => goWeek(1)} aria-label="Next week" className="p-2 rounded-lg hover:bg-gray-100 cursor-pointer">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <div className="flex items-center gap-3">
          {onFlush && syncState ? (
            <div className="flex items-center gap-2" role="status" aria-live="polite">
              <span className={`text-xs ${syncState === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
                {syncState === 'saved' ? 'All changes saved' :
                 syncState === 'saving' ? 'Saving…' :
                 syncState === 'offline' ? 'Offline — not saved yet' : 'Save failed — retry'}
              </span>
              <button type="button" disabled={syncState === 'saving'}
                onClick={() => void onFlush()}
                className="text-xs font-semibold text-[#111827] underline disabled:opacity-40">
                {syncState === 'error' || syncState === 'offline' ? 'Retry save' : 'Save now'}
              </button>
            </div>
          ) : <span className="hidden sm:inline text-xs text-gray-400">Changes save automatically</span>}
          {weekStart !== startOfWeek(today) && (
            <button onClick={goToday} className="text-xs font-semibold text-[#111827] underline cursor-pointer">
              This week
            </button>
          )}
        </div>
      </div>

      {/* Day strip */}
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2 mb-5">
        {days.map((d) => {
          const w = workoutOn(client, d);
          const st = w ? effectiveStatus(w, today) : null;
          const selected = d === selectedDate;
          return (
            <button
              key={d}
              onClick={() => {
                selectDate(d);
                setConfirmDelete(false);
                setCopyTo(null);
              }}
              aria-label={formatDate(d, { weekday: true })}
              aria-pressed={selected}
              className={`px-1.5 py-2 sm:p-3 rounded-xl sm:rounded-2xl border text-left cursor-pointer min-w-0 ${
                selected
                  ? 'bg-[#111827] text-white border-[#111827] shadow-sm'
                  : 'bg-white text-[#111827] border-gray-100 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] sm:text-xs font-bold">{dayShort(d)}</span>
                {st && <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_STYLE[st].dot}`} />}
              </div>
              <div className={`text-base sm:text-lg font-semibold tabular-nums leading-tight ${d === today && !selected ? 'text-[#B45309]' : ''}`}>
                {parseISODate(d).getDate()}
              </div>
              <div className={`hidden sm:block text-[11px] truncate ${selected ? 'text-gray-300' : 'text-gray-500'}`}>
                {w ? `${w.blocks.length} exercise${w.blocks.length === 1 ? '' : 's'}` : 'Rest'}
              </div>
            </button>
          );
        })}
      </div>

      {toast && (
        <div
          className={`mb-4 inline-flex items-center gap-2 text-xs font-medium px-3.5 py-2 rounded-xl ${
            toast.warn ? 'bg-[#FEF3C7] text-[#92400E]' : 'bg-[#111827] text-white'
          }`}
          role="status"
        >
          {toast.warn ? <AlertTriangle className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5 text-[#FFC809]" />}
          <span>{toast.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* ------------------------- Day editor ------------------------- */}
        <div
          className={`lg:col-span-7 lg:order-2 ${card} p-4 sm:p-6 ${isDragOver ? 'ring-2 ring-[#FFC809]' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            const ex = getExercise(e.dataTransfer.getData('text/plain'));
            if (ex) addExercise(ex);
          }}
        >
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              {formatDate(selectedDate, { weekday: true })}
              {selectedDate === today && <span className="ml-2 text-[#B45309]">Today</span>}
            </div>
            {workout && status && (
              <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${STATUS_STYLE[status].pill}`}>
                {STATUS_STYLE[status].label}
                {status === 'missed' && workout.status === 'planned' ? ' (nothing logged)' : ''}
              </span>
            )}
          </div>

          {!workout ? (
            <div className="py-10 text-center">
              <p className="text-base font-semibold text-[#111827] mb-1">Rest day</p>
              <p className="text-sm text-gray-500 mb-5">Add exercises from the library, or start a workout.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={() => saveWorkout(blankWorkout(selectedDate))}
                  className="inline-flex items-center gap-2 bg-[#111827] text-white text-sm font-semibold px-4 py-2.5 rounded-xl cursor-pointer"
                >
                  <Plus className="w-4 h-4 text-[#FFC809]" /> Create workout
                </button>
                {workoutOn(client, addDays(selectedDate, -7)) && (
                  <button
                    onClick={() => {
                      const r = copyWorkouts(client, [
                        { from: workoutOn(client, addDays(selectedDate, -7))!, toDate: selectedDate }
                      ]);
                      onUpdateClient(r.client);
                      flash('Repeated last week’s workout');
                    }}
                    className="inline-flex items-center gap-2 bg-white border border-gray-200 text-sm font-medium px-4 py-2.5 rounded-xl cursor-pointer"
                  >
                    <Copy className="w-4 h-4 text-gray-500" /> Repeat last {dayShort(selectedDate)}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Title / focus / notes */}
              <input
                value={workout.title}
                onChange={(e) => patchWorkout({ title: e.target.value })}
                placeholder="Workout title"
                aria-label="Workout title"
                className="w-full text-xl sm:text-2xl font-bold text-[#111827] bg-transparent focus:outline-none border-b border-transparent focus:border-gray-200 pb-1 mb-1"
              />
              <input
                value={workout.focus}
                onChange={(e) => patchWorkout({ focus: e.target.value })}
                placeholder="Focus (e.g. Hips & sagittal strength)"
                aria-label="Workout focus"
                className="w-full text-sm text-gray-500 bg-transparent focus:outline-none mb-3"
              />
              <textarea
                value={workout.coachNotes ?? ''}
                onChange={(e) => patchWorkout({ coachNotes: e.target.value })}
                placeholder="Notes for the client (warm-up, intent, reminders)…"
                rows={2}
                className="w-full text-base sm:text-sm bg-gray-50 border border-gray-100 rounded-xl px-3 py-2 focus:outline-none focus:border-gray-300 mb-4"
              />

              {/* Client's session feedback */}
              {(workout.sessionRpe || workout.clientFeedback) && (
                <div className="mb-4 p-3 rounded-xl bg-[#FFFDF5] border border-[#FEF3C7] text-sm">
                  <div className="font-semibold text-[#111827] mb-0.5">
                    Client feedback{workout.sessionRpe ? ` · Session RPE ${workout.sessionRpe}/10` : ''}
                  </div>
                  {workout.clientFeedback && <p className="text-gray-700">{workout.clientFeedback}</p>}
                </div>
              )}

              {/* Blocks */}
              <div className="space-y-3">
                {workout.blocks.map((b, i) => {
                  const last = lastPerformance(client, b.exerciseId, selectedDate);
                  const done = b.loggedSets.filter((s) => s.completed);
                  const isPaired = b.supersetWithPrevious;
                  return (
                    <div
                      key={b.id}
                      className={`rounded-2xl border p-3.5 sm:p-4 ${b.pain ? 'border-[#FCA5A5] bg-[#FFF7F7]' : 'border-gray-200'} ${
                        isPaired ? 'ml-3 sm:ml-5 border-l-4 border-l-[#FFC809]' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <span className="min-w-7 h-7 px-1.5 rounded-lg bg-[#111827] text-[#FFC809] text-xs font-bold flex items-center justify-center shrink-0">
                            {labels[i]}
                          </span>
                          <div className="min-w-0">
                            <div className="text-sm sm:text-base font-semibold text-[#111827] leading-snug">{b.name}</div>
                            {last && (
                              <div className="text-[11px] text-gray-500 mt-0.5">
                                Last ({formatDate(last.date)}): {formatPerformance(last)}
                                {last.rpe ? ` · RPE ${last.rpe}` : ''}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center shrink-0 -mr-1">
                          {i > 0 && (
                            <button
                              onClick={() => patchBlock(b.id, { supersetWithPrevious: !b.supersetWithPrevious })}
                              title={isPaired ? 'Unpair from previous exercise' : 'Pair with previous exercise (superset)'}
                              aria-label="Superset with previous"
                              className={`p-1.5 rounded-lg cursor-pointer ${isPaired ? 'text-[#B45309] bg-[#FEF3C7]' : 'text-gray-400 hover:text-[#111827]'}`}
                            >
                              <Link2 className="w-4 h-4" />
                            </button>
                          )}
                          <button onClick={() => moveBlock(i, -1)} disabled={i === 0} aria-label="Move up" className="p-1.5 rounded-lg text-gray-400 hover:text-[#111827] disabled:opacity-30 cursor-pointer">
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button onClick={() => moveBlock(i, 1)} disabled={i === workout.blocks.length - 1} aria-label="Move down" className="p-1.5 rounded-lg text-gray-400 hover:text-[#111827] disabled:opacity-30 cursor-pointer">
                            <ArrowDown className="w-4 h-4" />
                          </button>
                          <button onClick={() => removeBlock(b.id)} aria-label="Remove exercise" className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 cursor-pointer">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-4 gap-2 mb-2.5">
                        {(
                          [
                            ['Sets', 'sets'],
                            ['Reps', 'reps'],
                            [WEIGHT_UNIT, 'loadKg'],
                            ['Rest s', 'restSec']
                          ] as const
                        ).map(([label, key]) => (
                          <label key={key} className="block min-w-0">
                            <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
                            {key === 'reps' ? (
                              <RepsInput value={b.reps} onCommit={(reps) => patchBlock(b.id, { reps })} />
                            ) : key === 'sets' ? (
                              <SetsInput value={b.sets} onCommit={(sets) => patchBlock(b.id, { sets })} />
                            ) : key === 'loadKg' ? (
                              <WeightInput
                                min={0}
                                step={0.5}
                                kg={b.loadKg}
                                onChangeKg={(kg) => patchBlock(b.id, { loadKg: kg ?? 0 })}
                                className={numInput}
                              />
                            ) : (
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step={1}
                                value={b[key]}
                                onChange={(e) => {
                                  const v = Math.max(0, Number(e.target.value) || 0);
                                  patchBlock(b.id, {
                                    [key]: v
                                  } as Partial<WorkoutBlock>);
                                }}
                                className={numInput}
                              />
                            )}
                          </label>
                        ))}
                      </div>
                      <input
                        value={b.notes}
                        onChange={(e) => patchBlock(b.id, { notes: e.target.value })}
                        placeholder="Coaching note for this exercise"
                        className="w-full text-base sm:text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 focus:outline-none focus:border-gray-300"
                      />

                      {/* Client results */}
                      {(done.length > 0 || b.pain || b.clientNote) && (
                        <div className="mt-2.5 text-xs text-[#111827] bg-[#F9FAFB] rounded-lg px-3 py-2">
                          <span className="font-semibold">Logged: </span>
                          {done.length
                            ? done.map((s) => `${s.kg ? `${roundLb(s.kg)}×` : ''}${s.reps ?? '–'}`).join(', ')
                            : 'no sets'}
                          {b.rpe ? ` · RPE ${b.rpe}` : ''}
                          {b.pain && <span className="ml-1 font-semibold text-red-600">· Pain reported</span>}
                          {b.clientNote && <div className="text-gray-600 mt-0.5">“{b.clientNote}”</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                onClick={() => libraryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="lg:hidden mt-3 w-full inline-flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 text-sm font-semibold text-[#111827] py-3 rounded-2xl cursor-pointer"
              >
                <Plus className="w-4 h-4" /> Add exercise
              </button>

              {/* Day actions */}
              <div className="mt-5 pt-4 border-t border-gray-100 flex flex-wrap items-center gap-2">
                <label className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-gray-600">
                  <span>Status</span>
                  <select aria-label="Workout status" value={workout.status}
                    onChange={(event) => {
                      const next = event.target.value as Workout['status'];
                      patchWorkout(next === 'completed'
                        ? { status: next, completedAt: new Date().toISOString() }
                        : { status: next, completedAt: undefined });
                    }}
                    className="min-h-[44px] rounded-xl border border-gray-200 bg-white px-3 text-sm font-semibold text-[#111827]">
                    <option value="planned">Planned</option>
                    <option value="completed">Completed</option>
                    <option value="missed">Missed</option>
                  </select>
                </label>
                {copyTo !== null && (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <input type="date" value={copyTo} onChange={(e) => setCopyTo(e.target.value)}
                      aria-label="Copy to date" className="border border-gray-200 rounded-lg px-2 py-1.5 text-base sm:text-sm" />
                    <button onClick={handleCopyDay} disabled={!copyTo || copyTo === selectedDate}
                      className="min-h-[44px] px-3 rounded-lg text-sm font-semibold bg-[#111827] text-white disabled:opacity-40">Copy</button>
                    <button onClick={() => setCopyTo(null)} aria-label="Cancel copy"
                      className="min-h-[44px] px-2 text-gray-500"><X className="w-4 h-4" /></button>
                  </span>
                )}
                <span className="flex-1" />
                {confirmDelete && (
                  <div className="inline-flex flex-wrap items-center gap-2">
                    <button onClick={() => {
                      commitClient(removeWorkout(latestClientRef.current, workout.id));
                      setConfirmDelete(false);
                      flash('Workout deleted');
                    }} className="min-h-[44px] rounded-xl bg-red-600 px-3 text-sm font-semibold text-white">
                      Confirm delete workout
                    </button>
                    <button onClick={() => setConfirmDelete(false)}
                      className="min-h-[44px] px-2 text-sm text-gray-600">Cancel</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ------------------------- Library ------------------------- */}
        <div ref={libraryRef} className={`lg:col-span-5 lg:order-1 ${card} p-4 sm:p-5 scroll-mt-20`}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-[#111827]">Exercise Library</h2>
            <span className="text-[11px] text-gray-400">
              {results.length.toLocaleString()} exercises
            </span>
          </div>

          <div className="relative mb-3">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or muscle (try “db press”, “rdl”)…"
              className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:bg-white focus:border-[#111827]"
            />
          </div>

          <div className="flex flex-wrap min-w-0 items-center gap-1.5 pb-2 mb-2">
            {['All', ...MUSCLE_GROUPS].map((part) => (
              <button
                key={part}
                onClick={() => setBodyPart(part)}
                className={`min-h-[44px] px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer whitespace-nowrap ${
                  bodyPart === part ? 'bg-[#111827] text-white' : 'bg-[#F3F4F6] text-gray-600 hover:text-[#111827]'
                }`}
              >
                {part}
              </button>
            ))}
          </div>

          <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1 -mr-1">
            {results.slice(0, LIST_LIMIT).map((ex) => (
              <div
                key={ex.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', ex.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="group p-2 rounded-xl border border-gray-100 hover:border-gray-300 bg-white flex items-center justify-between gap-2.5 cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <GripVertical className="hidden sm:block w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0" />
                  <ExerciseThumb exercise={ex} compact className="w-14 h-10 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#111827] truncate">{ex.name}</div>
                    <div className="text-[11px] text-gray-500 truncate">
                      {[groupOf(ex), equipmentTypeOf(ex)].join(' · ')}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => addExercise(ex)}
                  aria-label={`Add ${ex.name}`}
                  className="w-9 h-9 rounded-lg bg-[#F3F4F6] hover:bg-[#111827] hover:text-white text-[#111827] flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            ))}
            {results.length > LIST_LIMIT && (
              <p className="text-[11px] text-gray-400 text-center py-2">
                Showing {LIST_LIMIT} of {results.length.toLocaleString()} — search to narrow down
              </p>
            )}
            {results.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No matches</p>}
          </div>
        </div>
      </div>
    </div>
  );
};
