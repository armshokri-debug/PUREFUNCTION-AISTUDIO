import React, { useState } from 'react';
import { Check, Copy, X, AlertCircle, Mail, Loader2 } from 'lucide-react';
import { ClientProfile } from '../../types';
import { isCloud } from '../../cloud/supabase';
import { sendInviteEmail } from '../../cloud/email';
import { emailCooldownKey } from '../../../supabase/functions/_shared/google-email-alias';

export function inviteLink(email: string): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL || '/'}`;
  return `${base}?join=${encodeURIComponent(email)}`;
}

/** Edit a client's name/email and share their invite (like TrueCoach's "Invite client"). */
export const ClientInviteModal: React.FC<{
  client: ClientProfile;
  clients: ClientProfile[];
  joined: boolean | null;
  onSave: (updated: ClientProfile) => void;
  onEnsureSaved?: () => Promise<boolean>;
  onInviteSent?: () => void;
  onClose: () => void;
}> = ({ client, clients, joined, onSave, onEnsureSaved, onInviteSent, onClose }) => {
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email);
  const [phaseValue, setPhaseValue] = useState<string>(
    `${client.phaseNumber}-${client.phaseName === 'Foundations' ? 'Reposition' : client.phaseName}`
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  const [mailing, setMailing] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [reminders, setReminders] = useState(client.emailReminders !== false);
  const [showDetails, setShowDetails] = useState(false);

  const savedEmail = (client.email ?? '').trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();
  const link = inviteLink(cleanEmail);
  const message = `Hi ${name.split(' ')[0] || ''}! Your coach invited you to Pure Function.\nOpen this manual setup link: ${link}\nChoose your password, then confirm your email using the second message that arrives. The secure email invitation above avoids this extra step.`;

  const save = () => {
    if (!name.trim()) return setError('Enter a name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return setError('Enter a valid email.');
    if (joined && cleanEmail !== savedEmail) return setError('An active account email cannot be changed here. Use a verified email-change process.');
    if (clients.some((c) => c.id !== client.id && emailCooldownKey(c.email ?? '') === emailCooldownKey(cleanEmail))) {
      return setError('This Gmail address already belongs to another client.');
    }
    const [numStr, pName] = phaseValue.split('-');
    const nextPhaseNumber = (Number(numStr) || client.phaseNumber) as 1 | 2 | 3 | 4;
    const nextPhaseName = (pName || client.phaseName) as ClientProfile['phaseName'];
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

  const emailInvite = async () => {
    if (mailing === 'sending') return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return setError('Enter a valid email.');
    if (cleanEmail !== savedEmail) return setError('Save the new email first, then send.');
    setError(null);
    setMailing('sending');
    if (onEnsureSaved) {
      const saved = await onEnsureSaved();
      if (!saved) {
        setMailing('idle');
        setError('Your client profile has not finished saving. Please retry after it is saved.');
        return;
      }
    }
    const err = await sendInviteEmail(client.id);
    if (err) {
      setMailing('idle');
      setError(err);
    } else {
      setMailing('sent');
      onInviteSent?.();
    }
  };

  const copy = async (what: 'link' | 'message') => {
    if (cleanEmail !== savedEmail) return setError('Save the changed email before copying a link.');
    try {
      await navigator.clipboard.writeText(what === 'link' ? link : message);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Copy failed — select the text and copy it manually.');
    }
  };

  const field =
    'w-full border border-gray-200 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-[#111827] focus:outline-none focus:border-[#111827]';

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-5 sm:p-6 shadow-xl max-h-[92dvh] overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[#111827]">Client & invite</h2>
          <button onClick={onClose} aria-label="Close" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-[#111827] cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {joined !== null && (
          <div
            className={`mb-4 text-sm rounded-xl px-3 py-2.5 ${
              joined ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#FEF3C7] text-[#92400E]'
            }`}
          >
            {joined
              ? 'Account active — this client has signed up.'
              : 'Not joined yet — send them the invite below.'}
          </div>
        )}

        {isCloud && !joined && (
          <div className="mt-4">
            <p className="text-sm text-gray-600 mb-3 break-words">
              Send a secure invitation to <strong>{client.name}</strong> at <strong>{client.email}</strong>.
              They will open one link, choose a password and start training.
            </p>
            <button
              onClick={() => void emailInvite()}
              disabled={mailing === 'sending' || mailing === 'sent'}
              className="w-full flex justify-center items-center gap-2 bg-[#111827] disabled:opacity-60 text-white text-sm font-semibold py-3.5 rounded-xl"
            >
              {mailing === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : mailing === 'sent' ? <Check className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
              {mailing === 'sending' ? 'Sending invitation…' : mailing === 'sent' ? 'Invitation sent' : 'Send invitation'}
            </button>
            {mailing === 'sent' && <p role="status" className="text-xs text-green-700 mt-2">
              Invitation accepted for delivery. Your client can check their inbox.
            </p>}
          </div>
        )}
        <button type="button" onClick={() => setShowDetails((value) => !value)}
          className="w-full text-sm underline text-gray-600 py-3 mt-1">
          {showDetails ? 'Hide details' : 'Edit details or share a link'}
        </button>
        {showDetails && (
        <>
        <label className="block text-xs font-medium text-gray-600 mb-1.5">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} mb-3`} />
        <label className="block text-xs font-medium text-gray-600 mb-1.5">Email (they sign in with this)</label>
        <input
          type="email"
          disabled={joined === true}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (mailing === 'sent') setMailing('idle');
            if (error) setError(null);
          }}
          className={field}
        />
        {joined && cleanEmail !== savedEmail && (
          <p className="text-xs text-[#92400E] mt-1.5">
            They already have an account with the old email; changing it here doesn’t change their login.
          </p>
        )}

        <label className="block text-xs font-medium text-gray-600 mt-3 mb-1.5">Phase</label>
        <select
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

        {isCloud && (
          <label className="mt-4 flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-sm text-[#111827]">
              Morning email on workout days
              <span className="block text-xs text-gray-500">A short reminder with today’s workout.</span>
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

        <div className="mt-5 p-3.5 rounded-xl bg-gray-50 border border-gray-100">
          <div className="text-xs font-semibold text-[#111827] mb-1">'Manual setup link (needs separate email verification)'</div>
          <div className="text-xs text-gray-600 break-all mb-3">{link}</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void copy('link')}
              className="inline-flex items-center justify-center gap-1.5 bg-white border border-gray-200 text-sm font-semibold py-2.5 rounded-xl cursor-pointer"
            >
              {copied === 'link' ? <Check className="w-4 h-4 text-[#16A34A]" /> : <Copy className="w-4 h-4" />}
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </button>
            <button
              onClick={() => void copy('message')}
              className="inline-flex items-center justify-center gap-1.5 bg-white border border-gray-200 text-sm font-semibold py-2.5 rounded-xl cursor-pointer"
            >
              {copied === 'message' ? <Check className="w-4 h-4 text-[#16A34A]" /> : <Copy className="w-4 h-4" />}
              {copied === 'message' ? 'Copied' : 'Copy message'}
            </button>
          </div>
          <p className="text-[11px] text-gray-500 mt-2">For one-email setup, use Send invitation above. Manual setup links require a second verification email.</p>
        </div>
        </>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2.5" role="alert">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-gray-500 cursor-pointer">
            Close
          </button>
          {showDetails && (
            <button onClick={save} className="bg-[#111827] text-white text-sm font-semibold px-5 py-2.5 rounded-xl cursor-pointer">
              Save changes
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
