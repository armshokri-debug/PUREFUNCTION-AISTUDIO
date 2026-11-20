// Shared by the email Edge Functions. Sends through Resend (https://resend.com).
// Secrets: RESEND_API_KEY (required), EMAIL_FROM (optional, needs a verified domain),
// APP_URL (optional).
import { resolveAppUrl } from './app-url.ts';
import {
  classifyMailFailure,
  CooldownTracker,
  cors,
  DEFAULT_FROM,
  isValidEmail,
  json,
  layout,
  resolveFromAddress,
  sendEmailWith,
  type SendEmailOptions,
  type SendResult
} from './email-core.ts';

export const APP_URL = resolveAppUrl(Deno.env.get('APP_URL'));
export { classifyMailFailure, CooldownTracker, cors, DEFAULT_FROM, isValidEmail, json, layout, resolveFromAddress };
export type { SendEmailOptions, SendResult };

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  options?: SendEmailOptions
): Promise<SendResult> {
  return sendEmailWith(
    {
      apiKey: Deno.env.get('RESEND_API_KEY'),
      from: Deno.env.get('EMAIL_FROM')
    },
    to,
    subject,
    html,
    options
  );
}
