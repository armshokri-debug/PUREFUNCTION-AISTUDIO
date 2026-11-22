import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { coachSignupLink, resolveAppUrl } from '../../../supabase/functions/_shared/app-url';
import { AuthScreen } from '../../cloud/AuthScreen';
import { sendCoachInvite } from '../../cloud/email';

const { rpc, invoke } = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn() }));
vi.mock('../../cloud/supabase', () => ({ supabase: { rpc, functions: { invoke } }, supabaseUrl: '' }));
vi.mock('../../cloud/Session', () => ({ useSession: () => ({ notice: null }) }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('shows the exact 403 and resends without changing the existing coach grant', async () => {
  const error = 'Email works only to your own address until a domain is verified in Resend.';
  invoke.mockResolvedValueOnce({ error: { context: Response.json({ error }, { status: 403 }) } });
  await expect(sendCoachInvite(' Coach@Example.invalid ', true)).resolves.toBe(error);
  expect(invoke).toHaveBeenCalledWith('invite-trainer', { body: { email: 'coach@example.invalid' } });
  expect(rpc).not.toHaveBeenCalled();
});

it('grants a new coach before inviting and stops if the grant fails', async () => {
  rpc.mockResolvedValueOnce({ error: { message: 'Head coach only' } });
  await expect(sendCoachInvite('coach@example.invalid', false)).resolves.toBe('Head coach only');
  expect(invoke).not.toHaveBeenCalled();

  rpc.mockResolvedValueOnce({ error: null });
  invoke.mockResolvedValueOnce({ data: { ok: true }, error: null });
  await expect(sendCoachInvite('coach@example.invalid', false)).resolves.toBeNull();
  expect(rpc).toHaveBeenLastCalledWith('pf_manage_trainer', { p_action: 'invite', p_email: 'coach@example.invalid', p_client_id: null });
  expect(rpc.mock.invocationCallOrder[1]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
});

it('opens coach signup at the deployed app base and preserves legacy coach sign-in and client links', () => {
  const signup = new URL(coachSignupLink(resolveAppUrl()));
  expect(signup.href).toBe('https://armshokri-debug.github.io/PUREFUNCTION-AISTUDIO/?coach=signup');
  const renderAuth = (search: string) => {
    vi.stubGlobal('window', { location: { search } });
    return renderToStaticMarkup(React.createElement(AuthScreen));
  };
  expect(renderAuth(signup.search)).toContain('>Create coach account</h1>');
  expect(renderAuth('?coach=1')).toContain('>Coach sign in</h1>');
  expect(renderAuth('?join=client%40example.invalid')).toContain('>Set up your account</h1>');
});
