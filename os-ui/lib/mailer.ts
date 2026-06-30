/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Outbound mail — a small, dependency-free, PLUGGABLE mailer for transactional
 * email (today: email verification; structured so user-invite mail can reuse it).
 *
 * Two transports, selected by config (`selectMailer()`), highest first:
 *   1. GRAPH — Microsoft Graph `sendMail` via OAuth2 client-credentials (fetch,
 *      no SDK). Recommended for Microsoft 365: it avoids SMTP basic-auth, which
 *      M365 is deprecating. Needs an Entra app registration with the Graph
 *      Application permission `Mail.Send` (+ admin consent).
 *   2. SMTP — a minimal built-in SMTP client (node:net/tls). Generic fallback for
 *      any standard relay.
 *   3. NONE — no mailer configured (the default): the platform works fully
 *      without email (the first-run bootstrap admin auto-verifies; later accounts
 *      are active without an email round-trip).
 *
 * Both transports share ONE interface (`sendVerificationEmail`) and ONE branded
 * template, so the verification/onboarding flow is identical regardless of which
 * (if any) transport is active.
 *
 * Config (all via env; secrets come from k8s Secrets, never committed):
 *   Graph:  GRAPH_TENANT_ID + GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET (all three) ;
 *           MAIL_FROM = sending mailbox / From (default support@datamasterclass.com)
 *   SMTP:   SMTP_HOST (presence = configured) ; SMTP_PORT (587, or 465 secure) ;
 *           SMTP_USER / SMTP_PASS (AUTH LOGIN, optional) ; SMTP_SECURE ("true" =
 *           implicit TLS) ; SMTP_FROM (default support@datamasterclass.com)
 *   Gate:   OS_EMAIL_VERIFICATION "false" force-disables verification even with a
 *           mailer present.
 *
 * `emailVerificationEnabled()` is true ONLY when SOME mailer is configured AND
 * verification is not force-disabled — so the flow never dead-ends on a "check
 * your email" that can never arrive.
 *
 * Secrets (client secret / token / SMTP password) are NEVER logged or returned.
 * Sends are best-effort: a failure returns false (only a non-sensitive status is
 * logged) and is swallowed — verification is non-blocking (an unverified account
 * can still sign in; verifying just confirms the address).
 */

const DEFAULT_FROM = 'support@datamasterclass.com';
const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH_HOST = 'https://graph.microsoft.com';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const HTTP_TIMEOUT_MS = 8000;

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  from: string;
};

export type SmtpConfig = {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  secure: boolean;
};

export type OutgoingMail = { to: string; from: string; subject: string; text: string; html: string };

export type MailerKind = 'graph' | 'smtp' | 'none';

// Test seam: inject an in-process transport so the verify path can be exercised
// without a live mailer. Production leaves this null and uses Graph/SMTP.
type Transport = (mail: OutgoingMail) => Promise<void>;
let transportOverride: Transport | null = null;
export function __setMailTransportForTests(fn: Transport | null): void {
  transportOverride = fn;
}

// Cached Graph app-only access token (per process). Reset between tests.
let tokenCache: { token: string; expiresAt: number } | null = null;
export function __resetGraphTokenCacheForTests(): void {
  tokenCache = null;
}

function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

// ---- Config (read live so config/tests can flip env between calls) ----------

export function graphConfig(): GraphConfig | null {
  const tenantId = envStr('GRAPH_TENANT_ID');
  const clientId = envStr('GRAPH_CLIENT_ID');
  const clientSecret = envStr('GRAPH_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, from: envStr('MAIL_FROM') ?? DEFAULT_FROM };
}

export function smtpConfig(): SmtpConfig | null {
  const host = envStr('SMTP_HOST');
  if (!host) return null;
  const secure = (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true';
  const port = Number(envStr('SMTP_PORT')) || (secure ? 465 : 587);
  return {
    host,
    port,
    user: envStr('SMTP_USER'),
    pass: envStr('SMTP_PASS'),
    from: envStr('SMTP_FROM') ?? DEFAULT_FROM,
    secure,
  };
}

/** Transport precedence: Graph > SMTP > none. (A test transport is handled
 * separately in sendVerificationEmail and does not change this selection.) */
export function selectMailer(): MailerKind {
  if (graphConfig()) return 'graph';
  if (smtpConfig()) return 'smtp';
  return 'none';
}

/** True when SOME mailer is configured (Graph or SMTP) — or a test transport. */
export function mailerConfigured(): boolean {
  return transportOverride !== null || selectMailer() !== 'none';
}

/**
 * True only when accounts should require email verification: a mailer is present
 * and the operator has not explicitly disabled it. With no mailer this is false,
 * so accounts are active immediately and the flow never dead-ends.
 */
export function emailVerificationEnabled(): boolean {
  if ((process.env.OS_EMAIL_VERIFICATION ?? '').toLowerCase() === 'false') return false;
  return mailerConfigured();
}

/** The configured sender address (for display/templates). Graph > SMTP > default. */
export function senderAddress(): string {
  return graphConfig()?.from ?? smtpConfig()?.from ?? DEFAULT_FROM;
}

// ---- Email content ----------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function verificationMail(to: string, link: string, from: string): OutgoingMail {
  const safeLink = escapeHtml(link);
  const text = [
    'Welcome to Sovereign Agentic OS.',
    '',
    'Confirm your email address to finish setting up your account:',
    link,
    '',
    'If you did not request this, you can ignore this message.',
    '',
    '— Sovereign Agentic OS',
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="margin:0;background:#141210;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8e2d6">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#1d1a16;border:1px solid #2c2820;border-radius:14px;overflow:hidden">',
    '<tr><td style="padding:28px 32px 8px">',
    '<div style="font-size:18px;font-weight:600;letter-spacing:.2px">Sovereign <span style="color:#c8a24a">Agentic</span> OS</div>',
    '</td></tr>',
    '<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6;color:#cfc8ba">',
    'Confirm your email address to finish setting up your account.',
    '</td></tr>',
    '<tr><td style="padding:24px 32px">',
    `<a href="${safeLink}" style="display:inline-block;background:#c8a24a;color:#141210;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:9px;font-size:14px">Verify email</a>`,
    '</td></tr>',
    '<tr><td style="padding:0 32px 28px;font-size:12px;line-height:1.6;color:#8c857a">',
    `If the button doesn't work, paste this link into your browser:<br><span style="color:#a79f92">${safeLink}</span>`,
    '<br><br>If you did not request this, you can ignore this message.',
    '</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
  return { to, from, subject: 'Verify your email — Sovereign Agentic OS', text, html };
}

// ---- Delivery (transport selection) -----------------------------------------

/**
 * Send the verification email through the selected transport. Best-effort:
 * returns false (never throws) when no mailer is configured or delivery fails —
 * callers must treat verification as non-blocking. No secret is ever logged.
 */
export async function sendVerificationEmail(to: string, link: string): Promise<boolean> {
  try {
    if (transportOverride) {
      await transportOverride(verificationMail(to, link, senderAddress()));
      return true;
    }
    const g = graphConfig();
    if (g) {
      await graphDeliver(verificationMail(to, link, g.from), g);
      return true;
    }
    const s = smtpConfig();
    if (s) {
      await smtpDeliver(verificationMail(to, link, s.from), s);
      return true;
    }
    return false;
  } catch (e) {
    // Swallow: delivery failures must not break account creation or leak details.
    // Log only a non-sensitive status (never a secret, token, or response body).
    console.warn(`mailer: sendMail failed (${(e as Error).message})`);
    return false;
  }
}

// ---- Microsoft Graph client (OAuth2 client-credentials; fetch, no SDK) -------

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** App-only access token via client-credentials, cached until shortly before
 * expiry. The client secret is sent only in the token request body — never logged. */
async function graphToken(cfg: GraphConfig): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  });
  const res = await fetchWithTimeout(`${TOKEN_HOST}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token status ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('token missing access_token');
  // Refresh a minute before the stated expiry (default ~3600s) to avoid races.
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 60);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttl * 1000 };
  return tokenCache.token;
}

/** POST /users/{from}/sendMail. Graph returns 202 Accepted on success. */
async function graphDeliver(mail: OutgoingMail, cfg: GraphConfig): Promise<void> {
  const token = await graphToken(cfg);
  const payload = {
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: [{ emailAddress: { address: mail.to } }],
    },
    saveToSentItems: false,
  };
  const res = await fetchWithTimeout(`${GRAPH_HOST}/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // 202 Accepted is the success code; treat any 2xx as ok.
  if (!res.ok) {
    // On 401 the cached token may be stale — drop it so the next send re-auths.
    if (res.status === 401) tokenCache = null;
    throw new Error(`sendMail status ${res.status}`);
  }
}

// ---- Minimal SMTP client (node:net / node:tls; no third-party dep) ----------

/**
 * A focused SMTP sender: EHLO → optional STARTTLS → optional AUTH LOGIN → MAIL
 * FROM / RCPT TO / DATA. Enough for transactional one-recipient mail through a
 * standard relay. Not a general MTA — by design it does the one job we need.
 */
async function smtpDeliver(mail: OutgoingMail, cfg: SmtpConfig): Promise<void> {
  let socket: net.Socket | tls.TLSSocket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });

  socket.setTimeout(HTTP_TIMEOUT_MS);
  let buffer = '';
  let resolveLine: ((line: string) => void) | null = null;
  let rejectAll: ((e: Error) => void) | null = null;

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    // SMTP replies end at a line "NNN <space>..." (no hyphen) → complete.
    let idx: number;
    while ((idx = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (/^\d{3} /.test(line) && resolveLine) {
        const r = resolveLine;
        resolveLine = null;
        r(line);
      }
    }
  };

  const done = new Promise<void>((resolve, reject) => {
    rejectAll = reject;
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('timeout', () => reject(new Error('smtp timeout')));
    socket.on('end', () => resolve());
  });

  function expect(): Promise<string> {
    return new Promise<string>((resolve) => {
      resolveLine = resolve;
    });
  }
  async function send(cmd: string): Promise<string> {
    socket.write(cmd + '\r\n');
    return expect();
  }
  function assertOk(line: string, allow: number[]): void {
    const code = Number(line.slice(0, 3));
    if (!allow.includes(code)) throw new Error(`smtp ${line.slice(0, 3)}`);
  }

  try {
    assertOk(await expect(), [220]); // server greeting
    let ehlo = await send(`EHLO ${cfg.host}`);
    assertOk(ehlo, [250]);

    if (!cfg.secure) {
      // Upgrade to TLS before sending any credential or message data.
      assertOk(await send('STARTTLS'), [220]);
      socket.removeListener('data', onData);
      const upgraded = tls.connect({ socket, servername: cfg.host });
      socket = upgraded;
      socket.setTimeout(HTTP_TIMEOUT_MS);
      buffer = '';
      socket.on('data', onData);
      socket.on('error', (e) => rejectAll?.(e));
      socket.on('timeout', () => rejectAll?.(new Error('smtp timeout')));
      await new Promise<void>((res, rej) => {
        upgraded.once('secureConnect', () => res());
        upgraded.once('error', rej);
      });
      ehlo = await send(`EHLO ${cfg.host}`);
      assertOk(ehlo, [250]);
    }

    if (cfg.user && cfg.pass) {
      assertOk(await send('AUTH LOGIN'), [334]);
      assertOk(await send(Buffer.from(cfg.user).toString('base64')), [334]);
      // Password is base64-encoded for the wire only — never logged in any form.
      assertOk(await send(Buffer.from(cfg.pass).toString('base64')), [235]);
    }

    assertOk(await send(`MAIL FROM:<${cfg.from}>`), [250]);
    assertOk(await send(`RCPT TO:<${mail.to}>`), [250, 251]);
    assertOk(await send('DATA'), [354]);

    const body = buildMessage(mail);
    socket.write(body + '\r\n.\r\n');
    assertOk(await expect(), [250]);
    socket.write('QUIT\r\n');
    socket.end();
    await Promise.race([done, delay(1000)]);
  } finally {
    socket.destroy();
  }
}

function buildMessage(mail: OutgoingMail): string {
  const boundary = `b_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    dotStuff(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    dotStuff(mail.html),
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers}\r\n\r\n${parts}`;
}

/** RFC 5321 dot-stuffing: a line starting with '.' must be doubled in DATA. */
function dotStuff(s: string): string {
  return s.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
