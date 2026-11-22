// Shared by the email Edge Functions. Sends through Resend (https://resend.com).
// Secrets: RESEND_API_KEY (required), EMAIL_FROM (optional, needs a verified domain),
// TRANSACTIONAL_EMAIL_FROM (optional, for student and coach invitations, sign-up and recovery),
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

function emailSender(senderSecret?: 'TRANSACTIONAL_EMAIL_FROM') {
  return (to: string, subject: string, html: string, options?: SendEmailOptions): Promise<SendResult> =>
    sendEmailWith(
      {
        apiKey: Deno.env.get('RESEND_API_KEY'),
        from: (senderSecret ? Deno.env.get(senderSecret) : undefined)
          ?? Deno.env.get('EMAIL_FROM')
      },
      to,
      subject,
      html,
      options
    );
}

export const sendEmail = emailSender();
export const sendTransactionalEmail = emailSender('TRANSACTIONAL_EMAIL_FROM');
