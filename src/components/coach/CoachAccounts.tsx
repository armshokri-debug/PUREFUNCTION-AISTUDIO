import React, { useEffect, useState } from 'react';
import { supabase } from '../../cloud/supabase';
import { sendCoachInvite } from '../../cloud/email';
import { coachSignupLink } from '../../../supabase/functions/_shared/app-url';
import { canCancelInvite, coachInviteState, type CoachInviteRow } from '../../lib/coachAccess';

/**
 * Head-coach-only management: a verified email is not necessarily an active coach.
 * No account deletion or automatic conversion of existing client accounts.
 */
export function CoachAccounts() {
  const [allowed, setAllowed] = useState(false);
  const [coaches, setCoaches] = useState<CoachInviteRow[]>([]);
  const [email, setEmail] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copyStatus, setCopyStatus] = useState('');

  const loadCoaches = async () => {
    if (!supabase) return;
    const result = await supabase.rpc('pf_list_trainers');
    if (result.error) {
      setMessage('Could not load coach accounts: ' + result.error.message);
    } else {
      setCoaches((result.data ?? []) as CoachInviteRow[]);
    }
  };

  useEffect(() => {
    let active = true;
    if (supabase) void supabase.rpc('pf_head_coach').then(async ({ data, error }) => {
      if (!active || error || data !== true) return;
      setAllowed(true);
      const list = await supabase!.rpc('pf_list_trainers');
      if (!active) return;
      if (list.error) setMessage('Could not load coach accounts: ' + list.error.message);
      else setCoaches((list.data ?? []) as CoachInviteRow[]);
    });
    return () => { active = false; };
  }, []);

  if (!supabase || !allowed) return null;
  const signupUrl = coachSignupLink(new URL(import.meta.env.BASE_URL, window.location.origin).href);
  const normalized = email.trim().toLowerCase();
  const existing = coaches.find((coach) => coach.email === normalized);
  const existingState = existing ? coachInviteState(existing) : null;
  const visible = coaches.filter((coach) =>
    (coach.display_name + ' ' + coach.email).toLowerCase().includes(search.trim().toLowerCase())
  );

  const invite = async (address: string) => {
    if (busy) return;
    const match = coaches.find((coach) => coach.email === address.trim().toLowerCase());
    const state = match ? coachInviteState(match) : null;
    if (state === 'active') {
      setMessage('This coach is already active. Ask them to sign in; do not send another signup invitation.');
      return;
    }
    if (state === 'existing_non_coach') {
      setMessage('This email belongs to an existing non-coach account. Use another email for this coach or arrange a separately reviewed account-role change. No account was changed.');
      return;
    }
    if (state === 'verification_needed') {
      setMessage('This coach account is waiting for email verification. Use the signup page to resend verification, not another invitation.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const error = await sendCoachInvite(address, Boolean(match));
      await loadCoaches(); // An allowlist grant may succeed even when Resend rejects delivery.
      setMessage(error
        ? 'Invitation email was not sent: ' + error + ' You can copy the signup link for an invited coach.'
        : 'Invitation request accepted. The coach can sign up using the invited email.');
      if (!error) setEmail('');
    } finally {
      setBusy(false);
    }
  };

  const cancelInvite = async (coach: CoachInviteRow) => {
    if (busy || !canCancelInvite(coach)) return;
    if (!window.confirm('Cancel invitation access for ' + coach.email + '? Existing accounts and user data will be preserved.')) return;
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await supabase!.rpc('pf_cancel_trainer_invite', { p_email: coach.email });
      if (error) {
        setMessage('Could not cancel invitation: ' + error.message);
      } else {
        setMessage(data === true ? 'Invitation access cancelled. No user account or data was deleted.' : 'Invitation was already cancelled.');
      }
      await loadCoaches();
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(signupUrl);
      setCopyStatus('Coach signup link copied.');
    } catch {
      setCopyStatus('Select the link to copy it manually.');
    }
  };

  return <section className="bg-white rounded-[28px] border border-gray-100 p-4 sm:p-6 mt-6 min-w-0">
    <h2 className="font-bold mb-1">Coaches</h2>
    <p className="text-sm text-gray-500 mb-4">Invite a coach by email. Each active coach has their own clients.</p>
    <form className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3" onSubmit={(event) => {
      event.preventDefault();
      void invite(email);
    }}>
      <input aria-label="Coach email" placeholder="Coach email address" type="email" required maxLength={254}
        value={email} onChange={(event) => setEmail(event.target.value)}
        className="min-w-0 w-full border rounded-xl p-3 text-base" />
      <button disabled={busy || existingState === 'active' || existingState === 'existing_non_coach' || existingState === 'verification_needed'}
        className="min-h-[44px] rounded-xl bg-[#111827] text-white px-4 disabled:opacity-40">
        {existingState === 'invited' ? 'Resend invite' : 'Invite coach'}
      </button>
    </form>
    {existingState === 'active' && <p className="text-sm mt-2">Already an active coach. They should sign in instead.</p>}
    {existingState === 'existing_non_coach' && <p className="text-sm mt-2">This is an existing non-coach account. It cannot be promoted or re-invited automatically.</p>}
    {existingState === 'verification_needed' && <p className="text-sm mt-2">Coach signup is pending email verification. Use the signup page to resend verification.</p>}
    {message && <p role="status" className="text-sm mt-3 break-words">{message}</p>}

    <div className="mt-5">
      <label htmlFor="coach-search" className="text-sm font-semibold">Coach invitations and accounts</label>
      <input id="coach-search" type="search" placeholder="Search by name or email" value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="mt-2 w-full border rounded-xl p-3 text-base" />
    </div>
    <ul className="space-y-3 mt-3">
      {visible.map((coach) => {
        const state = coachInviteState(coach);
        const label = state === 'active' ? 'Active coach'
          : state === 'verification_needed' ? 'Awaiting email verification'
          : state === 'existing_non_coach' ? 'Existing account — not a coach'
          : 'Invited — awaiting signup';
        return <li key={coach.email} className="border border-gray-100 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold break-all">{coach.display_name || coach.email}</p>
            {coach.display_name && <p className="text-xs text-gray-500 break-all">{coach.email}</p>}
            <p className="text-xs text-gray-600 mt-1">{label}</p>
          </div>
          {state === 'invited' && <button type="button" disabled={busy} onClick={() => void invite(coach.email)}
            className="min-h-[44px] border rounded-xl px-3 text-sm disabled:opacity-40">Resend invite</button>}
          {canCancelInvite(coach) && <button type="button" disabled={busy} onClick={() => void cancelInvite(coach)}
            className="min-h-[44px] border rounded-xl px-3 text-sm disabled:opacity-40">Cancel invitation</button>}
        </li>;
      })}
      {visible.length === 0 && <li className="text-sm text-gray-500">No matching coach invitations.</li>}
    </ul>

    <p className="text-sm mt-5">If an email cannot be delivered, copy this link and give it to the invited coach. They must use their allowlisted email.</p>
    <div className="flex flex-wrap gap-2 mt-2">
      <input aria-label="Coach signup link" value={signupUrl} readOnly onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 basis-64 flex-1 border rounded-xl p-2 text-base" />
      <button type="button" onClick={() => void copyLink()} className="min-h-[44px] border rounded-xl px-3 text-sm">Copy signup link</button>
    </div>
    {copyStatus && <p role="status" className="text-sm mt-2">{copyStatus}</p>}
  </section>;
}
