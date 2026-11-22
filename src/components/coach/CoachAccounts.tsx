import React, { useEffect, useState } from 'react';
import { supabase } from '../../cloud/supabase';
import { sendCoachInvite } from '../../cloud/email';
import { coachSignupLink } from '../../../supabase/functions/_shared/app-url';

/** Existing head-coach API; ownership remains automatic and cannot be transferred. */
export function CoachAccounts() {
  const [allowed, setAllowed] = useState(false);
  const [coaches, setCoaches] = useState<{ email: string; display_name: string; verified: boolean }[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    let active = true;
    if (supabase) void supabase.rpc('pf_head_coach').then(async ({ data, error }) => {
      if (!active || error || data !== true) return;
      setAllowed(true);
      const result = await supabase!.rpc('pf_list_trainers');
      if (active) { if (result.error) setMessage('Could not load coach accounts.'); else setCoaches(result.data ?? []); }
    });
    return () => { active = false; };
  }, []);
  if (!supabase || !allowed) return null;
  const signupUrl = coachSignupLink(new URL(import.meta.env.BASE_URL, window.location.origin).href);

  const invite = async (address: string, alreadyAllowed: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const error = await sendCoachInvite(address, alreadyAllowed);
      setMessage(error ?? 'Invitation sent. Email verification is required for new accounts.');
      if (!alreadyAllowed) {
        if (!error) setEmail('');
        const list = await supabase!.rpc('pf_list_trainers');
        if (!list.error) setCoaches(list.data ?? []);
      }
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
    <h2 className="font-bold mb-2">Coach accounts</h2>
    <p className="text-sm text-gray-500 mb-3">Each verified coach has an independent roster. New clients belong to the coach who creates them.</p>
    <ul className="space-y-2 text-sm">
      {coaches.map((coach) => <li key={coach.email} className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all">{coach.display_name || coach.email} · {coach.verified ? 'Verified' : 'Awaiting verification'}</span>
        <button type="button" disabled={busy} onClick={() => void invite(coach.email, true)}
          aria-label={`Resend invite to ${coach.email}`} className="min-h-[44px] border rounded-xl px-3 disabled:opacity-40">Resend invite</button>
      </li>)}
    </ul>
    <form className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 mt-4" onSubmit={(event) => {
      event.preventDefault();
      void invite(email, coaches.some((coach) => coach.email === email.trim().toLowerCase()));
    }}>
      <input aria-label="Coach email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-0 w-full border rounded-xl p-3 text-base" />
      <button disabled={busy} className="min-h-[44px] rounded-xl bg-[#111827] text-white px-4 disabled:opacity-40">Invite coach</button>
    </form>
    {message && <p role="status" className="text-sm mt-3 break-words">{message}</p>}
    <p className="text-sm mt-4">If email fails, share this link with the coach and ask them to use their allowlisted email.</p>
    <div className="flex flex-wrap gap-2 mt-2">
      <input aria-label="Coach signup link" value={signupUrl} readOnly onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 basis-64 flex-1 border rounded-xl p-2 text-base" />
      <button type="button" onClick={() => void copyLink()} className="min-h-[44px] border rounded-xl px-3 text-sm">Copy coach signup link</button>
    </div>
    {copyStatus && <p role="status" className="text-sm mt-2">{copyStatus}</p>}
  </section>;
}
