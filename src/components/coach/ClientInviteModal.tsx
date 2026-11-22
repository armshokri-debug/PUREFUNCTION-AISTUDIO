import React, { useState } from 'react';
import {
  Check,
  Copy,
  X,
  AlertCircle,
  Mail,
  Loader2,
  Clock,
  KeyRound,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { ClientProfile } from '../../types';
import { isCloud } from '../../cloud/supabase';
import { sendInviteEmailResult, type SendInviteErrorKind } from '../../cloud/email';
import { duplicateClientEmailMessage, findDuplicateClientByEmail } from '../../lib/clients';
import { formatDate } from '../../lib/workouts';

export const INVITE_EXPIRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function appSignInLink(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL || '/'}`;
}

export function inviteLink(email: string): string {
  return `${appSignInLink()}?join=${encodeURIComponent(email)}`;
}

export function isInviteLikelyExpired(invitedAt?: string, nowMs: number = Date.now()): boolean {
  if (!invitedAt) return false;
  const parsed = Date.parse(invitedAt);
  if (Number.isNaN(parsed)) return false;
  return nowMs - parsed >= INVITE_EXPIRY_WINDOW_MS;
}

export type ClientModalMode = 'edit' | 'invite';

/**
 * Clearly separated modal for either:
 * - mode="edit": editing client profile details (name, email, phase, reminders)
 * - mode="invite": sending/resending a secure invitation, or showing sign-in / password
 *   recovery guidance when the client already has an active account.
 */
export const ClientInviteModal: React.FC<{
  client: ClientProfile;
  clients: ClientProfile[];
  joined: boolean | null;
  mode?: ClientModalMode;
  onSwitchMode?: (nextMode: ClientModalMode) => void;
  onSave: (updated: ClientProfile) => void;
  onEnsureSaved?: () => Promise<boolean>;
  onInviteSent?: () => void;
  onClose: () => void;
}> = ({
  client,
  clients,
  joined,
  mode = 'invite',
  onSwitchMode,
  onSave,
  onEnsureSaved,
  onInviteSent,
  onClose
}) => {
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email);
  const [phaseValue, setPhaseValue] = useState<string>(
    `${client.phaseNumber}-${client.phaseName === 'Foundations' ? 'Reposition' : client.phaseName}`
  );
  const [reminders, setReminders] = useState(client.emailReminders !== false);

  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<SendInviteErrorKind | null>(null);
  const [copied, setCopied] = useState<'link' | 'message' | 'signin' | null>(null);
  const [mailing, setMailing] = useState<'idle' | 'sending' | 'accepted'>('idle');
  const [serverConfirmedActive, setServerConfirmedActive] = useState(false);
  const [showManualFallback, setShowManualFallback] = useState(false);

  const isActiveAccount = joined === true || serverConfirmedActive;
  const hasBeenInvited = Boolean(client.invitedAt);
  const inviteExpiredHint = !isActiveAccount && isInviteLikelyExpired(client.invitedAt);

  const savedEmail = (client.email ?? '').trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  const signInUrl = appSignInLink();
  const manualLink = inviteLink(savedEmail);
  const manualMessage = `Hi ${client.name.split(' ')[0] || ''}! Your coach invited you to Pure Function.\nOpen this manual setup link: ${manualLink}\nChoose your password, then confirm your email using the second message that arrives.`;

  const saveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return setError('Enter a valid email.');
    if (isActiveAccount && cleanEmail !== savedEmail) {
      return setError(
        'An active account email cannot be changed here. Use a verified email-change process.'
      );
    }
    const duplicate = findDuplicateClientByEmail(clients, cleanEmail, client.id);
    if (duplicate) {
      return setError(duplicateClientEmailMessage(cleanEmail, duplicate.email));
    }
    const [numStr, pName] = phaseValue.split('-');
    const nextPhaseNumber = (Number(numStr) || client.phaseNumber) as 1 | 2 | 3 | 4;
    const nextPhaseName = (pName || client.phaseName) as ClientProfile['phaseName'];
    setError(null);
    onSave({
      ...client,
      name: name.trim(),
      email: cleanEmail,
      phaseNumber: nextPhaseNumber,
      phaseName: nextPhaseName,
      emailReminders: reminders
    });
    onClose();
  };

  const handleSendInvite = async () => {
    if (mailing === 'sending' || isActiveAccount) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(savedEmail)) {
      setErrorKind('validation');
      setError('Add a valid email address in Edit Client before sending an invitation.');
      return;
    }
    setError(null);
    setErrorKind(null);
    setMailing('sending');

    if (onEnsureSaved) {
      const saved = await onEnsureSaved();
      if (!saved) {
        setMailing('idle');
        setErrorKind('delivery');
        setError('Your client profile has not finished saving. Please retry after it is saved.');
        return;
      }
    }

    const result = await sendInviteEmailResult(client.id);
    if (!result.ok) {
      setMailing('idle');
      setErrorKind(result.kind);
      setError(result.error);
      if (result.kind === 'already_active') {
        setServerConfirmedActive(true);
      }
      return;
    }

    setMailing('accepted');
    onInviteSent?.();
  };

  const copyText = async (what: 'link' | 'message' | 'signin') => {
    const value =
      what === 'signin' ? signInUrl : what === 'link' ? manualLink : manualMessage;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Copy failed — select the link and copy it manually.');
    }
  };

  const field =
    'w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:border-[#111827] disabled:bg-gray-50 disabled:text-gray-500';

  const modalTitle =
    mode === 'edit'
      ? 'Edit Client'
      : isActiveAccount
        ? 'Account Access'
        : hasBeenInvited
          ? 'Resend Invitation'
          : 'Invite Client';

  const primaryInviteLabel = hasBeenInvited ? 'Resend Invite' : 'Send Invite';
  const invitedDateLabel = client.invitedAt ? formatDate(client.invitedAt.slice(0, 10)) : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-modal-title"
        className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-5 sm:p-6 shadow-xl border border-gray-100 max-h-[92dvh] overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="min-w-0">
            <h2 id="client-modal-title" className="text-lg font-bold text-[#111827] truncate">
              {modalTitle}
            </h2>
            <p className="text-xs text-gray-500 truncate mt-0.5">{client.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-[#111827] hover:bg-gray-100 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {mode === 'edit' ? (
          <form onSubmit={saveEdit} className="space-y-4">
            <div>
              <label htmlFor="edit-client-name" className="block text-xs font-medium text-gray-600 mb-1.5">
                Full Name
              </label>
              <input
                id="edit-client-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                className={field}
                required
              />
            </div>

            <div>
              <label htmlFor="edit-client-email" className="block text-xs font-medium text-gray-600 mb-1.5">
                Email (they sign in with this)
              </label>
              <input
                id="edit-client-email"
                type="email"
                disabled={isActiveAccount}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                className={field}
                required
              />
              {isActiveAccount && (
                <p className="text-xs text-gray-500 mt-1.5">
                  This client already has an active sign-in account, so their login email is locked here.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="edit-client-phase" className="block text-xs font-medium text-gray-600 mb-1.5">
                Phase
              </label>
              <select
                id="edit-client-phase"
                value={phaseValue}
                onChange={(e) => setPhaseValue(e.target.value)}
                aria-label="Client phase"
                className={`${field} bg-white`}
              >
                <option value="1-Reposition">Phase 1 · Reposition</option>
                <option value="2-Integrate">Phase 2 · Integrate</option>
                <option value="3-Strength">Phase 3 · Strength</option>
                <option value="4-Performance">Phase 4 · Performance</option>
              </select>
            </div>

            {isCloud && (
              <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
                <span className="text-sm text-[#111827]">
                  Morning email on workout days
                  <span className="block text-xs text-gray-500">
                    A short reminder with today’s workout.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={reminders}
                  onChange={(e) => setReminders(e.target.checked)}
                  aria-label="Morning email on workout days"
                  className="w-5 h-5 accent-[#111827] shrink-0"
                />
              </label>
            )}

            {error && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5"
                role="alert"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-[#111827] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="min-h-[44px] bg-[#111827] hover:bg-[#1F2937] text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                Save changes
              </button>
            </div>
          </form>
        ) : isActiveAccount ? (
          <div className="space-y-4">
            <div className="text-sm rounded-xl px-3.5 py-3 bg-[#DCFCE7] text-[#166534]">
              Account active — this client has already signed up.
            </div>

            <p className="text-sm text-gray-600">
              Already registered. For access problems, use <strong>Forgot password</strong> on the sign-in page.
            </p>

            <div className="p-3.5 rounded-xl bg-[#F7F8FA] border border-gray-200/80 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#111827]">
                <KeyRound className="w-3.5 h-3.5 text-gray-500" />
                <span>Client sign-in link</span>
              </div>
              <div className="text-xs text-gray-600 break-all">{signInUrl}</div>
              <button
                type="button"
                onClick={() => void copyText('signin')}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-sm font-semibold text-[#111827] py-2.5 rounded-xl cursor-pointer transition-colors"
              >
                {copied === 'signin' ? (
                  <Check className="w-4 h-4 text-[#16A34A]" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
                <span>{copied === 'signin' ? 'Sign-in link copied' : 'Copy sign-in link'}</span>
              </button>
            </div>

            {error && (
              <div
                className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5"
                role="alert"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-[#111827] cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm rounded-xl px-3.5 py-3 bg-[#FEF3C7] text-[#92400E]">
              {inviteExpiredHint
                ? `Previous invitation (${invitedDateLabel}) may have expired — resend a fresh link below.`
                : hasBeenInvited
                  ? `Invited${invitedDateLabel ? ` on ${invitedDateLabel}` : ''} — not joined yet. You can resend a fresh invitation below.`
                  : 'Not joined yet — send them a secure invitation below.'}
            </div>

            {isCloud ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600 leading-relaxed break-words">
                  Invite <strong className="text-[#111827]">{savedEmail || 'no email set'}</strong> to access their workouts.
                </p>

                <button
                  type="button"
                  onClick={() => void handleSendInvite()}
                  disabled={mailing === 'sending' || mailing === 'accepted'}
                  className="w-full min-h-[44px] flex justify-center items-center gap-2 bg-[#111827] hover:bg-[#1F2937] disabled:opacity-60 text-white text-sm font-semibold py-3 rounded-xl transition-colors cursor-pointer"
                >
                  {mailing === 'sending' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : mailing === 'accepted' ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  <span>
                    {mailing === 'sending'
                      ? 'Sending invitation…'
                      : mailing === 'accepted'
                        ? 'Invitation accepted'
                        : primaryInviteLabel}
                  </span>
                </button>

                {mailing === 'accepted' && (
                  <p role="status" className="text-xs text-[#15803D] leading-relaxed">
                    Invitation accepted. Ask your client to check their inbox.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-600 leading-relaxed">
                Email invitations are sent in cloud mode. In local preview you can copy the setup
                link below.
              </p>
            )}

            {error && (
              <div
                className={`flex items-start gap-2 text-sm rounded-xl px-3 py-2.5 border ${
                  errorKind === 'cooldown' || errorKind === 'expired'
                    ? 'text-[#92400E] bg-[#FEF3C7]/70 border-[#F5B800]/30'
                    : 'text-red-700 bg-red-50 border-red-100'
                }`}
                role="alert"
              >
                {errorKind === 'cooldown' ? (
                  <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span>{error}</span>
              </div>
            )}

            <div className="pt-1 border-t border-gray-100 space-y-2">
              <button
                type="button"
                onClick={() => setShowManualFallback((prev) => !prev)}
                className="w-full min-h-[40px] flex items-center justify-between text-xs font-medium text-gray-600 hover:text-[#111827] cursor-pointer"
              >
                <span>Manual setup link (fallback)</span>
                {showManualFallback ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>

              {showManualFallback && (
                <div className="p-3.5 rounded-xl bg-[#F7F8FA] border border-gray-200/80 space-y-2.5">
                  <div className="text-xs text-gray-600 break-all">{manualLink}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void copyText('link')}
                      className="min-h-[44px] inline-flex items-center justify-center gap-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-xs font-semibold text-[#111827] py-2 rounded-xl cursor-pointer"
                    >
                      {copied === 'link' ? (
                        <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copied === 'link' ? 'Copied' : 'Copy link'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText('message')}
                      className="min-h-[44px] inline-flex items-center justify-center gap-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-xs font-semibold text-[#111827] py-2 rounded-xl cursor-pointer"
                    >
                      {copied === 'message' ? (
                        <Check className="w-3.5 h-3.5 text-[#16A34A]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copied === 'message' ? 'Copied' : 'Copy message'}</span>
                    </button>
                  </div>
                  
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              {onSwitchMode ? (
                <button
                  type="button"
                  onClick={() => onSwitchMode('edit')}
                  className="min-h-[44px] text-xs font-semibold text-gray-600 hover:text-[#111827] underline cursor-pointer"
                >
                  Edit client email
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-[#111827] cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
