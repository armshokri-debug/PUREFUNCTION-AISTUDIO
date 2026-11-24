import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Grip, MoveRight, X } from 'lucide-react';
import type { ClientProfile } from '../../types';
import {
  dayShort, effectiveStatus, formatDate, hasResults, orderLabels, parseISODate,
  type WorkoutTransferMode, type WorkoutTransferStatus, workoutOn
} from '../../lib/workouts';
import { formatWeight } from '../../lib/units';

const MIME = 'application/x-purefunction-weekly-workout';
type Clipboard = { fromDate: string; mode: WorkoutTransferMode };
type PendingReplace = Clipboard & { toDate: string };

interface WeeklyWorkoutBoardProps {
  client: ClientProfile;
  days: string[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onTransfer: (
    sourceDate: string,
    targetDate: string,
    mode: WorkoutTransferMode,
    replaceExisting?: boolean
  ) => WorkoutTransferStatus;
}

/** Coach-only, seven-day overview. Desktop shows the entire week; touch devices
 * swipe the horizontally scrolling row. Day editing stays in the existing builder. */
export const WeeklyWorkoutBoard: React.FC<WeeklyWorkoutBoardProps> = ({
  client, days, selectedDate, onSelectDate, onTransfer
}) => {
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [replace, setReplace] = useState<PendingReplace | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  useEffect(() => {
    setClipboard(null);
    setReplace(null);
    setHoverDate(null);
  }, [client.id]);

  const attempt = (fromDate: string, toDate: string, mode: WorkoutTransferMode, confirm = false) => {
    const result = onTransfer(fromDate, toDate, mode, confirm);
    if (result === 'destination-occupied') {
      setReplace({ fromDate, toDate, mode });
    } else if (result === 'done') {
      setClipboard(null);
      setReplace(null);
      onSelectDate(toDate);
    } else {
      setReplace(null);
    }
  };

  return (
    <section aria-label="Weekly workout overview" className="mb-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-[#111827]">Weekly workout calendar</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Seven days · exercises, sets and reps · drag to move or use Copy / Move
          </p>
        </div>
        {clipboard && (
          <div role="status" className="flex flex-wrap items-center gap-2 text-xs font-semibold rounded-xl bg-[#FFF4CF] px-3 py-2 text-[#92400E]">
            <span>{clipboard.mode === 'copy' ? 'Copy' : 'Move'} {formatDate(clipboard.fromDate, { weekday: true })} → choose Paste here</span>
            <button type="button" onClick={() => setClipboard(null)} aria-label="Cancel workout transfer"
              className="inline-flex items-center gap-1 underline min-h-[30px]">
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mb-2 xl:hidden">Swipe sideways to see all seven days.</p>
      <div role="region" tabIndex={0} aria-label="Scroll the full seven-day workout calendar"
        className="overflow-x-auto overscroll-x-contain pb-3 rounded-2xl">
        <div className="grid grid-cols-7 gap-2 min-w-[1120px] xl:min-w-0 items-stretch">
          {days.map((date) => {
            const workout = workoutOn(client, date);
            const labels = workout ? orderLabels(workout.blocks) : [];
            const status = workout ? effectiveStatus(workout) : null;
            const logged = Boolean(workout && hasResults(workout));
            const movingBlocked = Boolean(workout && (logged || workout.status !== 'planned'));
            const selected = date === selectedDate;
            const hovered = date === hoverDate;
            return (
              <article key={date}
                aria-label={`${formatDate(date, { weekday: true })} workout`}
                draggable={Boolean(workout) && !movingBlocked}
                onDragStart={(e) => {
                  if (!workout || movingBlocked) { e.preventDefault(); return; }
                  e.dataTransfer.setData(MIME, JSON.stringify({ clientId: client.id, fromDate: date }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => setHoverDate(null)}
                onDragOver={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(MIME)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setHoverDate(date);
                }}
                onDragLeave={() => setHoverDate((current) => current === date ? null : current)}
                onDrop={(e) => {
                  if (!Array.from(e.dataTransfer.types).includes(MIME)) return;
                  e.preventDefault();
                  setHoverDate(null);
                  try {
                    const value = JSON.parse(e.dataTransfer.getData(MIME)) as {clientId: string; fromDate: string};
                    if (value.clientId !== client.id || value.fromDate === date) return;
                    attempt(value.fromDate, date, 'move');
                  } catch { /* Ignore non-workout drag payloads. */ }
                }}
                className={`min-w-0 rounded-2xl border bg-white p-2.5 sm:p-3 flex flex-col ${hovered ? 'ring-2 ring-[#FFC809] border-[#FFC809]' : selected ? 'border-[#111827] shadow-sm' : 'border-gray-200'}`}
              >
                <button type="button" onClick={() => onSelectDate(date)}
                  aria-label={formatDate(date, { weekday: true })}
                  title="Select day to edit workout"
                  className="w-full flex items-center justify-between gap-1 rounded-lg px-1 py-1 text-left hover:bg-gray-50 cursor-pointer">
                  <span className="text-xs font-bold text-[#111827]">{dayShort(date)} {parseISODate(date).getDate()}</span>
                  {selected && <span className="text-[10px] font-bold text-[#B45309]">Editing</span>}
                </button>
                <div className="flex items-center justify-between gap-1 mt-2 mb-2">
                  <span className="text-[10px] font-semibold text-gray-500">{workout ? status : 'Rest day'}</span>
                  {workout && !movingBlocked && <Grip className="w-3.5 h-3.5 text-gray-400" aria-label="Drag workout to another day" />}
                </div>
                {workout ? (
                  <>
                    <div className="text-xs font-bold text-[#111827] leading-snug break-words mb-1">{workout.title || 'Workout'}</div>
                    {workout.focus && <div className="text-[11px] text-gray-500 mb-2 break-words">{workout.focus}</div>}
                    <div className="space-y-1.5 flex-1">
                      {workout.blocks.map((block, i) => (
                        <div key={block.id} className={`rounded-lg bg-[#F7F8FA] px-2 py-2 min-w-0 ${block.supersetWithPrevious ? 'border-l-2 border-[#FFC809]' : ''}`}>
                          <div className="text-[11px] font-semibold text-[#111827] leading-snug break-words">
                            <span className="text-[#B45309]">{labels[i]}</span> {block.name}
                          </div>
                          <div className="text-[11px] text-gray-600 mt-0.5">
                            {block.sets} sets × {block.reps || '–'} reps
                          </div>
                          {block.loadKg > 0 && <div className="text-[10px] text-gray-500">{formatWeight(block.loadKg)}</div>}
                          {block.restSec > 0 && <div className="text-[10px] text-gray-500">Rest {block.restSec}s</div>}
                          {block.notes && <p className="text-[10px] text-gray-500 mt-0.5 break-words">{block.notes}</p>}
                        </div>
                      ))}
                      {workout.blocks.length === 0 && <p className="text-xs text-gray-400">No exercises yet</p>}
                    </div>
                  </>
                ) : <p className="flex-1 text-xs text-gray-400 pt-2 pb-5">No workout planned</p>}
                <div className="mt-3 pt-2 border-t border-gray-100 space-y-1.5">
                  {workout && (
                    <div className="grid grid-cols-2 gap-1">
                      <button type="button" aria-label={`Copy ${formatDate(date, { weekday: true })} workout`}
                        onClick={() => setClipboard({ fromDate: date, mode: 'copy' })}
                        className="min-h-[34px] inline-flex items-center justify-center gap-1 rounded-lg bg-gray-100 text-[#111827] text-[11px] font-semibold hover:bg-gray-200 cursor-pointer">
                        <Copy className="w-3 h-3" /> Copy
                      </button>
                      <button type="button" disabled={movingBlocked}
                        title={movingBlocked ? 'Completed or logged workouts cannot be moved' : 'Move this workout'}
                        aria-label={`Move ${formatDate(date, { weekday: true })} workout`}
                        onClick={() => setClipboard({ fromDate: date, mode: 'move' })}
                        className="min-h-[34px] inline-flex items-center justify-center gap-1 rounded-lg bg-gray-100 text-[#111827] text-[11px] font-semibold hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
                        <MoveRight className="w-3 h-3" /> Move
                      </button>
                    </div>
                  )}
                  {clipboard && clipboard.fromDate !== date && (
                    <button type="button" disabled={logged}
                      aria-label={`Paste ${clipboard.mode === 'copy' ? 'copy' : 'move'} to ${formatDate(date, { weekday: true })}`}
                      title={logged ? 'Client results are protected' : 'Paste the selected workout on this day'}
                      onClick={() => attempt(clipboard.fromDate, date, clipboard.mode)}
                      className="w-full min-h-[36px] rounded-lg bg-[#111827] text-[#FFC809] text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
                      Paste here
                    </button>
                  )}
                  <button type="button" aria-label={`Open ${formatDate(date, { weekday: true })} editor`}
                    onClick={() => onSelectDate(date)}
                    className="w-full min-h-[32px] text-[11px] font-medium text-gray-600 underline cursor-pointer">
                    Edit day
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {replace && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setReplace(null)}>
          <div role="dialog" aria-modal="true" aria-label="Replace existing planned workout"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-center gap-2 text-[#92400E] mb-2">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="text-base font-bold text-[#111827]">Replace planned workout?</h3>
            </div>
            <p className="text-sm text-gray-700">
              {formatDate(replace.toDate, { weekday: true })} already has an unlogged workout.
              Replacing it removes that day's existing plan. Client results are never overwritten.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setReplace(null)}
                className="min-h-[44px] rounded-xl border border-gray-200 px-4 text-sm font-semibold">Cancel</button>
              <button type="button" onClick={() => attempt(replace.fromDate, replace.toDate, replace.mode, true)}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#111827] px-4 text-sm font-semibold text-white">
                <Check className="w-4 h-4 text-[#FFC809]" /> Replace plan
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
