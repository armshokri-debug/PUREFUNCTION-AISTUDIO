// Runtime-agnostic shared email utilities used by Edge Functions and unit tests.
// Never hardcodes a public sender domain as fallback: public sending stays off
// until EMAIL_FROM is explicitly configured in Supabase Edge Function secrets.

export const DEFAULT_FROM = 'Pure Function <onboarding@resend.dev>';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const isValidEmail = (value: string): boolean =>
  value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function resolveFromAddress(configured?: string): string {
  const from = configured?.trim();
  return from || DEFAULT_FROM;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function safeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Simple branded email: heading, paragraphs, one button. */
export function layout(heading: string, paragraphs: string[], button?: { text: string; url: string }): string {
  const safeUrl = button ? safeHttpUrl(button.url) : null;
  return `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <div style="font-weight:700;font-size:17px;margin-bottom:20px">Pure Function</div>
    <div style="background:#fff;border:1px solid #F3F4F6;border-radius:20px;padding:28px">
      <h1 style="font-size:22px;margin:0 0 12px">${esc(heading)}</h1>
      ${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;color:#374151;margin:0 0 12px">${esc(p)}</p>`).join('')}
      ${button && safeUrl ? `<a href="${esc(safeUrl)}" style="display:inline-block;margin-top:8px;background:#111827;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:12px">${esc(button.text)}</a>` : ''}
    </div>
    <p style="font-size:12px;color:#9CA3AF;margin-top:16px">Sent by your coach’s Pure Function app.</p>
  </div></body></html>`;
}

export type SendResult = { ok: true } | { ok: false; error: string; status: number };

export interface SendEmailOptions {
  /** Optional Resend Idempotency-Key (max 256 chars, deduplicates for 24 hours). */
  idempotencyKey?: string;
}

export interface SendEmailConfig {
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function sendEmailWith(
  config: SendEmailConfig,
  to: string,
  subject: string,
  html: string,
  options?: SendEmailOptions
): Promise<SendResult> {
  const key = config.apiKey?.trim();
  if (!key) return { ok: false, status: 503, error: 'Email is not set up yet (RESEND_API_KEY missing).' };

  const recipient = to.trim().toLowerCase();
  if (!isValidEmail(recipient)) {
    return { ok: false, status: 400, error: 'Invalid recipient email address.' };
  }

  const from = resolveFromAddress(config.from);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
  const idem = options?.idempotencyKey?.trim();
  if (idem) headers['Idempotency-Key'] = idem.slice(0, 256);

  const fetchFn = config.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ from, to: [recipient], subject, html }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 15000)
    });
  } catch {
    return { ok: false, status: 502, error: 'Email service could not be reached. Try again.' };
  }

  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  const msg = String((body as { message?: string }).message ?? res.statusText ?? '').trim();
  if (/testing emails|verify a domain|own email address|domain is not verified/i.test(msg)) {
    return {
      ok: false,
      status: 403,
      error: 'Email works only to your own address until a domain is verified in Resend.'
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      error: 'Too many emails sent right now. Wait a moment and try again.'
    };
  }
  return { ok: false, status: 502, error: `Email service error: ${msg || `HTTP ${res.status}`}` };
}

/** Classifies a SendResult failure into a fixed PII-free operational reason code. */
export function classifyMailFailure(result: Extract<SendResult, { ok: false }>): string {
  if (/only to your own address|verify.*domain/i.test(result.error)) return 'test_sender_restricted';
  if (/RESEND_API_KEY missing/.test(result.error)) return 'mail_not_configured';
  if (result.status === 429) return 'rate_limited';
  if (/could not be reached/i.test(result.error)) return 'provider_unreachable';
  return 'provider_rejected';
}

/** Bounded in-isolate cooldown store to reduce accidental rapid duplicate sends. */
export class CooldownTracker {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries = 500) {}

  isActive(key: string, cooldownMs: number, now = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (now >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  mark(key: string, cooldownMs: number, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries) {
      for (const [k, exp] of this.entries) {
        if (now >= exp) this.entries.delete(k);
      }
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, now + cooldownMs);
  }
}
