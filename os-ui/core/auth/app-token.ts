/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - the app identity token (D1): mint, verify, scope, the route allowlist
 * USER STORY: As a user of an app built in the OS I want the app to act as me (and only as me, only for what I agreed
 *             to), so I never give the app a password and the OS still checks every call against my current role.
 * ARCHITECTURE:
 *   - A JWS (EdDSA / Ed25519, `jose`, MIT) `{ iss, aud: "app:<domain>/<slug>:<env>", sub, scope, nonce?, iat, exp, jti }`
 *     with header `{ alg: EdDSA, kid, typ: os-app+jwt }`, 15 minutes. It carries NO role and NO domains: whoever
 *     accepts it re-reads the user record (role, domains, active) on every call (`authenticateAppBearer`).
 *   - The signing key is a JWK set in a mounted Secret (`config.appTokenKeyFile`, `os-app-token-key`). The FIRST key
 *     signs, every key verifies, `kid` selects: rotation = add a new key in front, keep the old one until the last
 *     token it signed expired (15 min), then drop it. A missing or malformed key file FAILS CLOSED (`AppTokenUnavailable`):
 *     nothing is minted and no bearer is accepted. The file is re-read when its mtime changes (a Secret update).
 *   - `scope` = `read` always, `agent-run` when the app has agent grants, one `action:<name>` per declared WRITE action.
 *     Never `approval-decide`, never an admin verb, never a generic governed write (D2 is out of scope).
 *   - The kernel never imports a tab: what it needs to know about an app (audience per env, callback hosts, grants,
 *     agent grants, declared write actions) arrives through the `AppTokenPort` the Software tab's sources register at
 *     boot (`os-ui/app-token-sources.ts`, wired in `instrumentation.ts`). No port ⇒ no app is resolvable ⇒ every app
 *     login and every bearer is refused (fail closed).
 *   - `APP_TOKEN_ROUTES` is the ONLY set of OS routes an app bearer is accepted on (spec section 8 "Acceptance").
 *     Each entry names the scope it needs and the grant check on the path parameter; a route not listed answers as
 *     if unauthenticated. Reads by id must be inside the app's grants AND inside what the user consented to.
 */
import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { SignJWT, decodeProtectedHeader, importJWK, jwtVerify, type CryptoKey, type JWK, type JWTPayload } from 'jose';
import { config } from '@core/kernel/config';

// ------------------------------------------------------------------ constants --

export const APP_TOKEN_TTL_SEC = 15 * 60;
export const APP_TOKEN_TYP = 'os-app+jwt';
export const APP_TOKEN_ALG = 'EdDSA';
export type AppTokenEnv = 'dev' | 'prod';
export const APP_TOKEN_ENVS: readonly AppTokenEnv[] = ['dev', 'prod'];
export const isAppTokenEnv = (v: unknown): v is AppTokenEnv => v === 'dev' || v === 'prod';

export const SCOPE_READ = 'read';
export const SCOPE_AGENT_RUN = 'agent-run';
export const SCOPE_ACTION_PREFIX = 'action:';
/** Scopes that never appear in an app token, whatever the app declares. */
export const NEVER_SCOPES: readonly string[] = ['approval-decide', 'admin', 'write', 'governed-write'];
/** A declared action name as it may appear in a scope (actions.yml names are snake_case identifiers). */
const ACTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The header the edge middleware sets (sealed; deleted from every request first): see core/kernel/app-route-header.ts. */
export { APP_ROUTE_HEADER } from '@core/kernel/app-route-header';

/** Typed refusal: the key is missing or malformed. Fail closed (503), never a fallback key. */
export class AppTokenUnavailable extends Error {
  readonly code = 'app_token_unavailable';
  readonly status = 503;
  constructor(reason: string) {
    super(`App sign-in is not available: ${reason}`);
    this.name = 'AppTokenUnavailable';
  }
}

/** Typed refusal of a presented token (signature, kid, issuer, expiry, audience, scope, consent, route). */
export class AppTokenRejected extends Error {
  readonly code = 'app_token_rejected';
  readonly status = 401;
  constructor(reason: string) {
    super(reason);
    this.name = 'AppTokenRejected';
  }
}

// ------------------------------------------------------------- the app view --

/** What the kernel knows about an app — built by the Software tab's port (never by the kernel). */
export type AppTokenApp = {
  id: string;
  name: string;
  domain: string;
  slug: string;
  /** `appAudience(domain, slug, env)` from the App Builder contracts, per env. */
  audience: Record<AppTokenEnv, string>;
  /** The exact registered callback hosts per env: prod = the prod host; dev = the dev host + preview slots p1, p2. */
  callbackHosts: Record<AppTokenEnv, string[]>;
  /** Granted read ids per kind (the app's context grants), with display names for the consent screen. */
  reads: { kind: 'data' | 'metrics' | 'knowledge' | 'files'; id: string; name: string }[];
  /** Granted agent systems (ids, names). Non-empty ⇒ the `agent-run` scope. */
  agents: { id: string; name: string }[];
  /** Declared WRITE actions (actions.yml, `write: true`) with the scopes they declare. */
  writeActions: { name: string; description: string; scopes: string[] }[];
  /** Does any declared action touch `records`? (`os.records` is reachable only when declared.) */
  recordsDeclared: boolean;
};

/** The live principal (role/domains re-read from the user record on every call). */
export type AppPrincipal = { id: string; name: string; role: string; domains: string[] };

export type AppTokenPort = {
  /** The app (domain, slug) as `principal` may SEE it now, or null (absent, archived or unseeable). */
  appFor(principal: AppPrincipal, domain: string, slug: string, opts?: { withNames?: boolean }): Promise<AppTokenApp | null>;
  /** The app id the `/api/apps/by-slug/<slug>/*` routes would resolve for this principal (or null). */
  bySlugFor(principal: AppPrincipal, slug: string): Promise<string | null>;
};

const PORT_KEY = Symbol.for('soa.core.app-token-port');
type PortSlot = { port: AppTokenPort | null };
function portSlot(): PortSlot {
  const g = globalThis as unknown as Record<symbol, PortSlot | undefined>;
  if (!g[PORT_KEY]) g[PORT_KEY] = { port: null };
  return g[PORT_KEY]!;
}
/** Install (or remove, with null) the Software tab's app resolver. The last registration wins. */
export function registerAppTokenPort(port: AppTokenPort | null): void {
  portSlot().port = port;
}
/** The registered port, or the typed refusal (fail closed). */
export function appTokenPort(): AppTokenPort {
  const p = portSlot().port;
  if (!p) throw new AppTokenUnavailable('the app resolver is not registered in this process');
  return p;
}

// --------------------------------------------------------------------- scope --

/** The scope an app's token carries: `read`; `agent-run` with agent grants; `action:<name>` per declared write. */
export function appTokenScope(app: Pick<AppTokenApp, 'agents' | 'writeActions'>): string[] {
  const out = new Set<string>([SCOPE_READ]);
  if (app.agents.length > 0) out.add(SCOPE_AGENT_RUN);
  for (const a of app.writeActions) {
    if (ACTION_NAME.test(a.name)) out.add(`${SCOPE_ACTION_PREFIX}${a.name}`);
  }
  for (const n of NEVER_SCOPES) out.delete(n);
  return [...out].sort();
}

/** Parse the space-separated `scope` claim; anything outside the known shapes is dropped (and fails the subset check). */
export function parseScope(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(' ').filter(Boolean))].sort();
}

export const isSubset = (a: readonly string[], b: readonly string[]): boolean => a.every((x) => b.includes(x));

// ---------------------------------------------------------------------- keys --

type KeyEntry = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; publicJwk: JWK };
export type AppTokenKeySet = { signing: KeyEntry; byKid: Map<string, KeyEntry> };

/** Where the JWK-set JSON comes from. Default: `config.appTokenKeyFile` (re-read when its mtime changes). */
export type KeySource = { id: string; version(): Promise<string>; read(): Promise<string> };

export function fileKeySource(path: string = config.appTokenKeyFile): KeySource {
  return {
    id: `file:${path}`,
    version: async () => {
      if (!path) throw new AppTokenUnavailable('no signing key is configured (OS_APP_TOKEN_KEY_FILE is empty)');
      try {
        const s = await stat(path);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        throw new AppTokenUnavailable('the signing key file cannot be read');
      }
    },
    read: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        throw new AppTokenUnavailable('the signing key file cannot be read');
      }
    },
  };
}

/** Parse and import a JWK set. Every key must be an Ed25519 private JWK with a unique `kid`. Throws AppTokenUnavailable. */
export async function importKeySet(json: string): Promise<AppTokenKeySet> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new AppTokenUnavailable('the signing key file is not JSON');
  }
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new AppTokenUnavailable('the signing key file holds no keys');
  const byKid = new Map<string, KeyEntry>();
  const order: KeyEntry[] = [];
  for (const [i, k] of keys.entries()) {
    const jwk = k as JWK;
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
      throw new AppTokenUnavailable(`key ${i} is not an Ed25519 private key`);
    }
    if (typeof jwk.kid !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(jwk.kid)) throw new AppTokenUnavailable(`key ${i} has no valid kid`);
    if (byKid.has(jwk.kid)) throw new AppTokenUnavailable(`kid ${jwk.kid} appears twice`);
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    try {
      privateKey = (await importJWK({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, APP_TOKEN_ALG)) as CryptoKey;
      publicKey = (await importJWK({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, APP_TOKEN_ALG)) as CryptoKey;
    } catch {
      throw new AppTokenUnavailable(`key ${jwk.kid} cannot be imported`);
    }
    const entry: KeyEntry = { kid: jwk.kid, privateKey, publicKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid, alg: APP_TOKEN_ALG, use: 'sig' } };
    byKid.set(jwk.kid, entry);
    order.push(entry);
  }
  return { signing: order[0], byKid };
}

type KeyCache = { source: string; version: string; set: AppTokenKeySet };
const KEY_CACHE = Symbol.for('soa.core.app-token-keys');
function keyCache(): { c: KeyCache | null } {
  const g = globalThis as unknown as Record<symbol, { c: KeyCache | null } | undefined>;
  if (!g[KEY_CACHE]) g[KEY_CACHE] = { c: null };
  return g[KEY_CACHE]!;
}

/** The current key set (cached per source version). Throws AppTokenUnavailable — never a fallback key. */
export async function loadAppTokenKeys(source: KeySource = fileKeySource()): Promise<AppTokenKeySet> {
  const version = await source.version();
  const c = keyCache().c;
  if (c && c.source === source.id && c.version === version) return c.set;
  const set = await importKeySet(await source.read());
  keyCache().c = { source: source.id, version, set };
  return set;
}

/** Test seam. */
export function __resetAppTokenForTests(): void {
  keyCache().c = null;
  portSlot().port = null;
}

/** The public JWKS (`/api/auth/app-jwks`): every key, public half only. */
export async function appTokenJwks(source?: KeySource): Promise<{ keys: JWK[] }> {
  const set = await loadAppTokenKeys(source);
  return { keys: [...set.byKid.values()].map((k) => ({ ...k.publicJwk })) };
}

/** The issuer: `OS_APP_TOKEN_ISSUER`, else the OS public URL. Empty ⇒ fail closed. */
export function appTokenIssuer(): string {
  const iss = config.appTokenIssuer || config.osPublicUrl;
  if (!iss) throw new AppTokenUnavailable('no issuer is configured (OS_APP_TOKEN_ISSUER / OS_PUBLIC_URL)');
  return iss;
}

// --------------------------------------------------------------- mint/verify --

export type MintInput = { app: Pick<AppTokenApp, 'audience'>; env: AppTokenEnv; scope: string[]; nonce?: string };
export type MintDeps = { keys?: KeySource; issuer?: string; now?: () => number };

/** Mint an app token for `user`. The scope must already be the app's derived scope (or a subset of it). */
export async function mintAppToken(user: { id: string }, input: MintInput, deps: MintDeps = {}): Promise<{ token: string; expiresIn: number; jti: string }> {
  if (!user?.id) throw new AppTokenRejected('no user');
  if (!isAppTokenEnv(input.env)) throw new AppTokenRejected('unknown env');
  const scope = [...new Set(input.scope)].sort();
  if (scope.some((s) => NEVER_SCOPES.includes(s))) throw new AppTokenRejected('a forbidden scope was requested');
  const aud = input.app.audience[input.env];
  if (!aud) throw new AppTokenRejected('the app has no audience for this env');
  const set = await loadAppTokenKeys(deps.keys);
  const iss = deps.issuer ?? appTokenIssuer();
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const jti = randomUUID();
  const claims: JWTPayload = { scope: scope.join(' ') };
  if (input.nonce) claims.nonce = input.nonce;
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: APP_TOKEN_ALG, kid: set.signing.kid, typ: APP_TOKEN_TYP })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(user.id)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + APP_TOKEN_TTL_SEC)
    .setJti(jti)
    .sign(set.signing.privateKey);
  return { token, expiresIn: APP_TOKEN_TTL_SEC, jti };
}

export type AppTokenClaims = { sub: string; aud: string; scope: string[]; jti: string; exp: number; iat: number; nonce?: string };

/** Cheap shape check (no crypto): a three-part JWS whose header says `typ: os-app+jwt`. */
export function looksLikeAppToken(token: string): boolean {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) return false;
  try {
    return decodeProtectedHeader(token).typ === APP_TOKEN_TYP;
  } catch {
    return false;
  }
}

/**
 * Verify signature (kid must be a key we hold), alg, typ, issuer, expiry and — when `expect` is given — the exact
 * audience. Throws AppTokenRejected (or AppTokenUnavailable when no key is configured).
 */
export async function verifyAppToken(
  token: string,
  expect: { audience?: string } = {},
  deps: { keys?: KeySource; issuer?: string; now?: () => number } = {},
): Promise<AppTokenClaims> {
  const set = await loadAppTokenKeys(deps.keys);
  const iss = deps.issuer ?? appTokenIssuer();
  let payload: JWTPayload;
  try {
    const out = await jwtVerify(
      token,
      async (header) => {
        const k = header.kid ? set.byKid.get(header.kid) : undefined;
        if (!k) throw new AppTokenRejected('unknown key id');
        return k.publicKey;
      },
      {
        algorithms: [APP_TOKEN_ALG],
        typ: APP_TOKEN_TYP,
        issuer: iss,
        ...(expect.audience ? { audience: expect.audience } : {}),
        requiredClaims: ['sub', 'aud', 'exp', 'iat', 'jti'],
        currentDate: new Date((deps.now ?? Date.now)()),
        clockTolerance: 5,
      },
    );
    payload = out.payload;
  } catch (e) {
    if (e instanceof AppTokenRejected) throw e;
    // A matched reason only — never the token or a library message that may echo it.
    const code = (e as { code?: string })?.code ?? '';
    const reason =
      code === 'ERR_JWT_EXPIRED' ? 'token expired'
        : code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' ? `token claim invalid (${String((e as { claim?: string }).claim ?? 'unknown')})`
          : code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? 'token signature invalid'
            : 'token invalid';
    throw new AppTokenRejected(reason);
  }
  if (typeof payload.aud !== 'string') throw new AppTokenRejected('token audience must be a single app');
  if (payload.exp! - payload.iat! > APP_TOKEN_TTL_SEC + 5) throw new AppTokenRejected('token lifetime too long');
  return {
    sub: String(payload.sub),
    aud: payload.aud,
    scope: parseScope(payload.scope),
    jti: String(payload.jti),
    exp: payload.exp!,
    iat: payload.iat!,
    ...(typeof payload.nonce === 'string' ? { nonce: payload.nonce } : {}),
  };
}

/** `app:<domain>/<slug>:<env>` → its parts (the inverse of the contracts' `appAudience`), or null. */
export function parseAudience(aud: string): { domain: string; slug: string; env: AppTokenEnv } | null {
  const m = /^app:([^/:\s]+)\/([^/:\s]+):(dev|prod)$/.exec(aud);
  return m ? { domain: m[1], slug: m[2], env: m[3] as AppTokenEnv } : null;
}

/** A stable, non-reversible fingerprint of a token for logs and audit (never the token itself). */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------- route allowlist --

export type RouteNeed =
  | { kind: 'scope'; scope: string }
  | { kind: 'grant'; scope: string; grant: 'data' | 'metrics' | 'files'; param: number }
  | { kind: 'agent'; param: number }
  | { kind: 'app-slug'; param: number; scope: string; records?: 'read' | 'write' };

export type AppTokenRoute = { id: string; method: 'GET' | 'POST'; pattern: RegExp; need: RouteNeed; note: string };

const SEG = '([^/]+)';
/** Literal siblings of `/api/metrics/[id]` that must never be read as a metric id. */
const METRIC_LITERALS = new Set(['agent', 'alerts', 'assistant', 'define', 'explore', 'govern', 'preview']);

/**
 * The ONLY OS routes an app bearer is accepted on (spec section 8). Everything else — every write route, every
 * approval door (`/api/governance/approvals` included), every list that is not limited to the app's grants — answers
 * as if no credential was sent. Generic lists (`/api/data/datasets`, `/api/knowledge/docs`, `/api/data/ask`,
 * `/api/metrics/explore`) are NOT here: they return what the USER sees, not what the APP was granted; the app reads
 * its granted list from `/api/apps/by-slug/<slug>/context`.
 */
export const APP_TOKEN_ROUTES: readonly AppTokenRoute[] = Object.freeze([
  { id: 'whoami', method: 'GET', pattern: /^\/api\/auth\/me$/, need: { kind: 'scope', scope: SCOPE_READ }, note: 'os.whoami' },
  { id: 'app-context', method: 'GET', pattern: new RegExp(`^/api/apps/by-slug/${SEG}/context$`), need: { kind: 'app-slug', param: 1, scope: SCOPE_READ }, note: 'os.context (the app\'s own grants)' },
  { id: 'records-list', method: 'GET', pattern: new RegExp(`^/api/apps/by-slug/${SEG}/records$`), need: { kind: 'app-slug', param: 1, scope: SCOPE_READ, records: 'read' }, note: 'os.records.list (declared only)' },
  { id: 'records-get', method: 'GET', pattern: new RegExp(`^/api/apps/by-slug/${SEG}/records/${SEG}$`), need: { kind: 'app-slug', param: 1, scope: SCOPE_READ, records: 'read' }, note: 'os.records.get (declared only)' },
  { id: 'records-add', method: 'POST', pattern: new RegExp(`^/api/apps/by-slug/${SEG}/records$`), need: { kind: 'app-slug', param: 1, scope: SCOPE_READ, records: 'write' }, note: 'os.records.add/update/remove (a declared write action on records)' },
  { id: 'records-export', method: 'POST', pattern: new RegExp(`^/api/apps/by-slug/${SEG}/records/export$`), need: { kind: 'app-slug', param: 1, scope: SCOPE_READ, records: 'write' }, note: 'os.records.export (a declared write action on records)' },
  { id: 'dataset-get', method: 'GET', pattern: new RegExp(`^/api/data/datasets/${SEG}$`), need: { kind: 'grant', scope: SCOPE_READ, grant: 'data', param: 1 }, note: 'os.datasets.get (granted only)' },
  { id: 'dataset-preview', method: 'GET', pattern: new RegExp(`^/api/data/datasets/${SEG}/preview$`), need: { kind: 'grant', scope: SCOPE_READ, grant: 'data', param: 1 }, note: 'os.datasets.query preview (granted only)' },
  { id: 'metric-get', method: 'GET', pattern: new RegExp(`^/api/metrics/${SEG}$`), need: { kind: 'grant', scope: SCOPE_READ, grant: 'metrics', param: 1 }, note: 'a granted metric definition' },
  { id: 'file-get', method: 'GET', pattern: new RegExp(`^/api/files/${SEG}$`), need: { kind: 'grant', scope: SCOPE_READ, grant: 'files', param: 1 }, note: 'os.files.get (granted only)' },
  { id: 'agent-run', method: 'POST', pattern: new RegExp(`^/api/agents/systems/${SEG}/run$`), need: { kind: 'agent', param: 1 }, note: 'os.agents.run (granted agents only)' },
  { id: 'agent-run-stream', method: 'GET', pattern: new RegExp(`^/api/agents/systems/${SEG}/run/stream$`), need: { kind: 'agent', param: 1 }, note: 'os.agents.get (granted agents only)' },
]);

/** Match `<METHOD> <pathname>` against the allowlist; path parameters are decoded (a decoded `/` never matches). */
export function matchAppTokenRoute(method: string, pathname: string): { route: AppTokenRoute; params: string[] } | null {
  if (!pathname.startsWith('/api/') || pathname.includes('//') || /(^|\/)\.\.?(\/|$)/.test(pathname)) return null;
  for (const route of APP_TOKEN_ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: string[] = [];
    for (const raw of m.slice(1)) {
      // Ids, slugs and system ids are URL-safe, so a percent-encoded segment is never a legitimate one: refusing
      // `%` outright closes every encoding trick (`%2F`, double encoding, invalid UTF-8) without decoding.
      if (!raw || raw.includes('%') || raw.includes('\\')) return null;
      params.push(raw);
    }
    if (route.id === 'metric-get' && METRIC_LITERALS.has(params[0])) return null;
    return { route, params };
  }
  return null;
}

/** What the user consented to for this app+env (core/auth/app-consent.ts `AppConsent`, structural). */
export type ConsentView = { scopes: string[]; reads: string[]; agents: string[] };

export const readKey = (kind: string, id: string) => `${kind}:${id}`;

/** The route decision for a verified token: scope, grant, consent and the by-slug identity of the app. */
export function appTokenRouteDecision(
  route: AppTokenRoute,
  params: string[],
  ctx: { app: AppTokenApp; scopes: readonly string[]; consent: ConsentView; bySlugAppId?: string | null },
): { ok: true } | { ok: false; reason: string } {
  const has = (s: string) => ctx.scopes.includes(s) && ctx.consent.scopes.includes(s);
  const need = route.need;
  switch (need.kind) {
    case 'scope':
      return has(need.scope) ? { ok: true } : { ok: false, reason: `scope ${need.scope} missing` };
    case 'grant': {
      if (!has(need.scope)) return { ok: false, reason: `scope ${need.scope} missing` };
      const id = params[need.param - 1];
      if (!ctx.app.reads.some((r) => r.kind === need.grant && r.id === id)) return { ok: false, reason: `${need.grant} ${id} is not granted to the app` };
      if (!ctx.consent.reads.includes(readKey(need.grant, id))) return { ok: false, reason: `${need.grant} ${id} is not in the user's consent` };
      return { ok: true };
    }
    case 'agent': {
      if (!has(SCOPE_AGENT_RUN)) return { ok: false, reason: 'scope agent-run missing' };
      const id = params[need.param - 1];
      if (!ctx.app.agents.some((a) => a.id === id)) return { ok: false, reason: `agent ${id} is not granted to the app` };
      if (!ctx.consent.agents.includes(id)) return { ok: false, reason: `agent ${id} is not in the user's consent` };
      return { ok: true };
    }
    case 'app-slug': {
      if (!has(need.scope)) return { ok: false, reason: `scope ${need.scope} missing` };
      if (params[need.param - 1] !== ctx.app.slug) return { ok: false, reason: 'the route serves another app' };
      // Slugs are unique per domain only: the by-slug routes must resolve to THIS app for this user.
      if (!ctx.bySlugAppId || ctx.bySlugAppId !== ctx.app.id) return { ok: false, reason: 'the slug resolves to another app for this user' };
      if (need.records && !ctx.app.recordsDeclared) return { ok: false, reason: 'the app declares no records scope' };
      if (need.records === 'write') {
        const writesRecords = ctx.app.writeActions.some((a) => a.scopes.includes('records') && has(`${SCOPE_ACTION_PREFIX}${a.name}`));
        if (!writesRecords) return { ok: false, reason: 'no consented declared write action on records' };
      }
      return { ok: true };
    }
  }
}

// ----------------------------------------------------- accepting a bearer --

export type BearerDeps = {
  /** The live user record (null = deleted or deactivated). */
  principal: (id: string) => Promise<AppPrincipal | null>;
  /** The user's current consent for (appId, env), or null. Undefined = the consent store did not answer. */
  consent: (userId: string, app: AppTokenApp, env: AppTokenEnv) => Promise<ConsentView | null | undefined>;
  port?: AppTokenPort;
  keys?: KeySource;
  issuer?: string;
  now?: () => number;
};

export type AcceptedAppBearer = { principal: AppPrincipal; app: AppTokenApp; env: AppTokenEnv; via: string; scopes: string[]; jti: string };

/**
 * Accept an app bearer for ONE request (`<method> <pathname>`), or throw AppTokenRejected/Unavailable. In order:
 * the route is on the allowlist; signature/kid/issuer/expiry; the user is active (role and domains re-read now);
 * the app exists and the user may still see it; the audience is exactly that app's for this env; the token's scope
 * is inside the app's CURRENT derived scope (a removed grant or action shrinks it at once); the user's consent is
 * present and covers the scope; and the route's own grant/consent/slug check passes.
 */
export async function authenticateAppBearer(token: string, method: string, pathname: string, deps: BearerDeps): Promise<AcceptedAppBearer> {
  const match = matchAppTokenRoute(method, pathname);
  if (!match) throw new AppTokenRejected('this route does not accept an app token');
  const claims = await verifyAppToken(token, {}, deps);
  const aud = parseAudience(claims.aud);
  if (!aud) throw new AppTokenRejected('token audience is not an app');
  const principal = await deps.principal(claims.sub);
  if (!principal) throw new AppTokenRejected('the user is not active');
  const port = deps.port ?? appTokenPort();
  const app = await port.appFor(principal, aud.domain, aud.slug);
  if (!app) throw new AppTokenRejected('the app is not visible to the user');
  if (app.audience[aud.env] !== claims.aud) throw new AppTokenRejected('token audience does not match the app');
  if (!isSubset(claims.scope, appTokenScope(app))) throw new AppTokenRejected('token scope exceeds what the app may do now');
  const consent = await deps.consent(principal.id, app, aud.env);
  if (consent === undefined) throw new AppTokenRejected('consent could not be checked');
  if (!consent || !isSubset(claims.scope, consent.scopes)) throw new AppTokenRejected('no consent for this scope');
  const bySlugAppId = match.route.need.kind === 'app-slug' ? await port.bySlugFor(principal, match.params[0]) : undefined;
  const d = appTokenRouteDecision(match.route, match.params, { app, scopes: claims.scope, consent, bySlugAppId });
  if (!d.ok) throw new AppTokenRejected(d.reason);
  return { principal, app, env: aud.env, via: claims.aud, scopes: claims.scope, jti: claims.jti };
}

/** Bearer value of an `Authorization` header, or null. */
export function bearerOf(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return m ? m[1] : null;
}
