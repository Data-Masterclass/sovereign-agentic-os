/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform → Encryption keys: the admin operations on the connection-credential keys
 * USER STORY: As an admin I see the key provider and its health, save the recovery key once, rotate,
 *             switch provider, test a restore and unlock after one — and every change asks me to prove
 *             it is really me (my password again) and lands in the audit log.
 * ARCHITECTURE:
 *   - One entry point, `runKeyOp(ctx, body, deps)`, for every POST of /api/platform-admin/encryption-keys
 *     (the route is thin). Ops: recovery-generate, recovery-confirm, test-restore, restore, rotate,
 *     switch, test-provider, provider-credential.
 *   - RE-AUTHENTICATION: every op needs the admin's CURRENT PASSWORD in the request, verified with the
 *     same `authenticate()` the sign-in uses — a stolen session cookie alone cannot touch the keys.
 *     Failed attempts are rate-limited per admin (5 / 15 min) and audited as `denied`. The limiter is
 *     IN-PROCESS (core/kernel/ratelimit.ts): it holds because the chart runs ONE os-ui replica (the
 *     worker serves no HTTP). With N replicas behind the Service the effective limit is N × 5 — move the
 *     counter to the shared store before scaling os-ui out.
 *   - AUDIT: every op — success, refusal or error — is one `audit()` record (action
 *     `encryption-keys.<op>`). Details carry ids and provider names only: never a key, a recovery key
 *     or a provider credential.
 *   - The recovery key is returned ONCE (recovery-generate) and never logged or audited.
 *   - Dependencies are injected (`authenticate`, `audit`, the key-manager ops) so the re-auth and audit
 *     rules unit-test without a request (encryption-keys.test.ts).
 */
import { rateLimit, rateLimitReset } from '@core/kernel/ratelimit';
import type { AuditResult } from '@tabs/admin/lib/audit';
import type * as KM from '@core/infra/key-manager';

export type KeyOp = 'recovery-generate' | 'recovery-confirm' | 'test-restore' | 'restore' | 'rotate' | 'switch' | 'test-provider' | 'provider-credential';
export const KEY_OPS: readonly KeyOp[] = ['recovery-generate', 'recovery-confirm', 'test-restore', 'restore', 'rotate', 'switch', 'test-provider', 'provider-credential'];

export type KeyOpDeps = {
  authenticate(username: string, password: string): Promise<unknown | null>;
  audit(e: { tenant: string; actor: string; role: string; action: string; target: string; detail: string; result?: AuditResult }): unknown;
  km: Pick<typeof KM, 'generateRecoveryKey' | 'confirmRecoveryKey' | 'testRestore' | 'restoreWithRecoveryKey' | 'rotateKeys' | 'switchProvider' | 'testProviderConfig' | 'updateProviderCredential' | 'keyView'>;
  /** After a change: adopt the new keyring in this process now. */
  reload(): Promise<void>;
};

export type KeyOpCtx = { user: { id: string; role: string }; tenant: { id: string } };
export type KeyOpResult = { status: number; body: Record<string, unknown> };

const REAUTH_LIMIT = 5;
const REAUTH_WINDOW_MS = 15 * 60_000;

export async function runKeyOp(ctx: KeyOpCtx, body: Record<string, unknown>, deps: KeyOpDeps): Promise<KeyOpResult> {
  const op = String(body?.op ?? '') as KeyOp;
  const record = (result: AuditResult, detail: string) =>
    deps.audit({ tenant: ctx.tenant.id, actor: ctx.user.id, role: ctx.user.role, action: `encryption-keys.${op || 'unknown'}`, target: 'connection-keys', detail, result });
  if (!KEY_OPS.includes(op)) {
    record('error', 'unknown operation');
    return { status: 400, body: { error: 'Unknown operation' } };
  }

  // RE-AUTHENTICATION — the admin's password, every time.
  const rl = `encryption-keys-reauth:${ctx.user.id}`;
  const password = String(body?.password ?? '');
  if (!password) {
    record('denied', 're-authentication required (no password given)');
    return { status: 401, body: { error: 'Enter your password to confirm this change', code: 'reauth-required' } };
  }
  const gate = rateLimit(rl, REAUTH_LIMIT, REAUTH_WINDOW_MS);
  if (!gate.ok) {
    record('denied', 're-authentication rate-limited');
    return { status: 429, body: { error: `Too many attempts — try again in ${Math.ceil(gate.retryAfter / 60)} min`, code: 'reauth-limited' } };
  }
  if (!(await deps.authenticate(ctx.user.id, password))) {
    record('denied', 're-authentication failed (wrong password)');
    return { status: 401, body: { error: 'That password is not right', code: 'reauth-failed' } };
  }
  rateLimitReset(rl);

  const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string) : '');
  const cfg = (body?.config && typeof body.config === 'object' ? body.config : {}) as Record<string, string>;
  try {
    switch (op) {
      case 'recovery-generate': {
        const { recoveryKey } = await deps.km.generateRecoveryKey(ctx.user.id);
        record('ok', 'new recovery key generated (shown once; only its verifier is stored)');
        return { status: 200, body: { recoveryKey, view: deps.km.keyView() } };
      }
      case 'recovery-confirm': {
        if (body?.saved !== true) {
          record('denied', 'confirmation not given');
          return { status: 400, body: { error: 'Tick "I saved the recovery key" to confirm' } };
        }
        await deps.km.confirmRecoveryKey(ctx.user.id, str('recoveryKey'));
        record('ok', 'recovery key confirmed as saved');
        return { status: 200, body: { view: deps.km.keyView() } };
      }
      case 'test-restore': {
        const r = await deps.km.testRestore(str('recoveryKey') || undefined);
        record(r.recovery === 'wrong-key' || r.provider === 'failed' ? 'error' : 'ok', `test restore: recovery ${r.recovery}, provider ${r.provider}`);
        return { status: 200, body: { result: r } };
      }
      case 'restore': {
        const target = str('provider') ? { provider: str('provider'), config: cfg, credential: str('credential') || undefined } : undefined;
        const res = await deps.km.restoreWithRecoveryKey(str('recoveryKey'), ctx.user.id, target);
        await deps.reload();
        record('ok', `stored credentials unlocked with the recovery key; data keys re-wrapped under ${res.provider}${res.fellBackFrom ? ` (${res.fellBackFrom} could not be used)` : ''}`);
        return { status: 200, body: { result: res, view: deps.km.keyView() } };
      }
      case 'rotate': {
        const newDataKey = body?.newDataKey === true;
        const { currentKeyId } = await deps.km.rotateKeys({ newDataKey }, ctx.user.id);
        await deps.reload();
        record('ok', newDataKey ? `new data key ${currentKeyId}; credentials re-seal in the background` : 'data keys re-wrapped under the provider');
        return { status: 200, body: { view: deps.km.keyView() } };
      }
      case 'switch': {
        const provider = str('provider');
        const { health } = await deps.km.switchProvider(provider, cfg, str('credential') || undefined, ctx.user.id);
        await deps.reload();
        record('ok', `key provider switched to ${provider} (every data key re-wrapped and verified)`);
        return { status: 200, body: { health, view: deps.km.keyView() } };
      }
      case 'test-provider': {
        const provider = str('provider');
        const health = await deps.km.testProviderConfig(provider, cfg, str('credential') || undefined);
        record(health.ok ? 'ok' : 'error', `test connection to ${provider}: ${health.state}`);
        return { status: 200, body: { health } };
      }
      case 'provider-credential': {
        await deps.km.updateProviderCredential(str('credential'), ctx.user.id);
        await deps.reload();
        record('ok', 'provider credential replaced (verified by unwrapping the data keys)');
        return { status: 200, body: { view: deps.km.keyView() } };
      }
    }
  } catch (e) {
    // A provider error that escaped as-is is still a named failure, not a raw 500.
    const status = (e as { status?: number })?.status ?? ((e as Error)?.name === 'KeyProviderError' ? 502 : 500);
    const msg = e instanceof Error ? e.message : String(e);
    record(status < 500 ? 'denied' : 'error', msg.slice(0, 300));
    return { status, body: { error: msg } };
  }
  return { status: 400, body: { error: 'Unknown operation' } };
}
