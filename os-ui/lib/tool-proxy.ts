/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { ROLES, SESSION_COOKIE, type Role } from '@/lib/session';

/**
 * Same-origin, server-proxied tool embedding.
 *
 * Every embeddable backend tool is reachable at
 * `https://<os-host>/tools/<key>/…` — served BY the os-ui Node server, never a
 * client-side or localhost address. The browser only ever presents the OS
 * session cookie; this module turns that into whatever the upstream tool needs:
 *
 *  - `sso.mode:'header'` — Level-1 trusted-proxy SSO: inject `X-Forwarded-User`
 *    (+ a tool-specific alias like Forgejo's `X-WEBAUTH-USER`), a preferred-
 *    username, and a role header mapped through `roleMap`. The tool auto-
 *    provisions the account on first request. Credentials never touch the wire.
 *  - `sso.mode:'basic'` — inject a shared server-side credential as HTTP Basic
 *    (the browser never sees it). For tools fronted by a single service login.
 *  - `sso.mode:'session'` — the tool has NO trusted-header mode (Langfuse's
 *    NextAuth). The proxy signs a server-only service account in server-side and
 *    injects the resulting session cookie (lib/tool-sso-langfuse.ts) so no second
 *    login is shown; the password never reaches the browser.
 *  - `sso.mode:'none'` — no per-user account exists (MLflow/Dagster/Cube OSS);
 *    the proxy + role gate IS the access control. Nothing is injected.
 *
 * On the way back it strips `X-Frame-Options`, pins CSP `frame-ancestors 'self'`
 * (so the OS shell can iframe it but nobody else can), and rewrites `Location`
 * + `Set-Cookie; Path=` into the `/tools/<key>` prefix. The body is STREAMED —
 * never buffered — so large tool pages and downloads pass straight through.
 */

export type Protocol = 'http' | 'ws';
export type SsoMode = 'header' | 'basic' | 'session' | 'none';

export type ToolSso = {
  mode: SsoMode;
  /** Header the tool reads the username from (canonical X-Forwarded-User is always set too). */
  userHeader?: string;
  /** Where the mapped role lands (default X-Forwarded-Roles). */
  rolesHeader?: string;
  /** OS role → tool role/group string. */
  roleMap?: Partial<Record<Role, string>>;
  /** For mode:'basic' — a shared server-side credential (resolved from config). */
  basic?: { user: string; pass: string };
};

export type Tool = {
  key: string;
  title: string;
  /** Server-side upstream base URL (in-cluster Service), reused from lib/config.ts. */
  upstream: string;
  protocol: Protocol;
  frame: 'strip';
  basePath: string;
  /** Lowest role (by rank) allowed to open the tool. */
  minRole: Role;
  /** false → no framable UI (WebSocket-only or headless): render a status panel, not an iframe. */
  embeddable: boolean;
  sso: ToolSso;
  note?: string;
};

/** Structural principal — avoids importing the server-only auth facade into tests. */
export type Principal = { id: string; name: string; domains: string[]; role: Role };

/* ------------------------------------------------------------------ registry */

/**
 * The tool registry. Upstreams reuse the server-side URLs already in
 * lib/config.ts. `minRole` is the OS-side access gate; `sso.roleMap` is the
 * downstream provisioning role. WS / headless tools carry `embeddable:false`
 * and are documented here so the surface stays a single source of truth even
 * though the HTTP proxy will not serve them.
 */
export const TOOLS: Record<string, Tool> = {
  // --- Pilot + HTTP-embeddable tools (served now) -------------------------
  mlflow: {
    key: 'mlflow',
    title: 'MLflow',
    upstream: config.mlflowUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/mlflow',
    minRole: 'creator',
    embeddable: true,
    sso: { mode: 'none' }, // MLflow OSS has no per-user accounts; proxy+role is the gate.
    note: 'MLflow OSS is unauthenticated internally; the OS role gate is the access control.',
  },
  featureform: {
    key: 'featureform',
    title: 'Featureform',
    upstream: config.featureformUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/featureform',
    minRole: 'creator',
    embeddable: true,
    sso: { mode: 'none' },
    note: 'Featureform OSS has no per-user accounts; the proxy + role gate IS the access control. creator+ (matches MLflow, its Science-tab sibling) so a creator can open it from the Layer-4 grid.',
  },
  cube: {
    key: 'cube',
    title: 'Cube',
    upstream: config.cubeUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/cube',
    minRole: 'creator',
    embeddable: true,
    sso: { mode: 'none' }, // Cube dev playground; add a JWT on STACKIT.
    note: 'Cube Playground (dev mode). No per-user account; add a JWT for prod.',
  },
  forgejo: {
    key: 'forgejo',
    title: 'Forgejo',
    upstream: config.forgejoUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/forgejo',
    minRole: 'creator',
    embeddable: true,
    sso: {
      mode: 'header',
      userHeader: 'X-WEBAUTH-USER', // Forgejo REVERSE_PROXY_AUTHENTICATION default header
      roleMap: { admin: 'owner' }, // informational; org-owner provisioning is tool-side
    },
    note: 'Reverse-proxy auth (REVERSE_PROXY_AUTHENTICATION); auto-registers on first login.',
  },
  superset: {
    key: 'superset',
    title: 'Superset',
    upstream: config.supersetInternalUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/superset',
    minRole: 'creator',
    embeddable: true,
    sso: {
      mode: 'header',
      roleMap: { admin: 'Admin', builder: 'Alpha', 'creator': 'Gamma' },
    },
    note: 'AUTH_REMOTE_USER + auto-user-registration; role via X-Forwarded-Roles.',
  },
  langfuse: {
    key: 'langfuse',
    title: 'Langfuse',
    upstream: config.langfuseUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/langfuse',
    // Admin-only: the embedded console shows EVERY project trace (agent I/O
    // across users), unlike the per-user-scoped Monitoring API. Non-admins use
    // Monitoring for their own traces.
    minRole: 'admin',
    embeddable: true,
    sso: { mode: 'session' }, // NextAuth: proxy signs a server-only account in.
    note: 'NextAuth SSO — the proxy establishes the session server-side (lib/tool-sso-langfuse.ts); no second login, password never reaches the browser.',
  },
  litellm: {
    key: 'litellm',
    title: 'LLM Gateway',
    upstream: config.litellmUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/litellm',
    // All users; the tab opens ONLY the public, key-free Model Hub. No auth is
    // injected — the LiteLLM master key must NEVER reach the browser, so the
    // admin UI (spend/keys) simply shows its own login if navigated to.
    minRole: 'creator',
    embeddable: true,
    sso: { mode: 'none' },
    note: "Read-only public Model Hub only (/public/model_hub). No credential injected — the master key stays server-side; LiteLLM's admin UI stays behind its own login.",
  },
  opensearch: {
    key: 'opensearch',
    title: 'OpenSearch Dashboards',
    upstream: config.opensearchDashboardsInternalUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/opensearch',
    minRole: 'builder',
    embeddable: true,
    sso: {
      mode: 'header',
      roleMap: { admin: 'all_access', builder: 'read', 'creator': 'read' },
    },
    note: 'Proxy/JWT header auth; admin → all_access, else read.',
  },
  openmetadata: {
    key: 'openmetadata',
    title: 'OpenMetadata',
    upstream: config.openmetadataApiUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/openmetadata',
    minRole: 'creator',
    embeddable: true,
    sso: {
      mode: 'header',
      roleMap: { admin: 'Admin', builder: 'DataConsumer', 'creator': 'DataConsumer' },
    },
    note: 'Header/JWT auth; off by default locally (~2.5 GB JVM).',
  },
  // Dagster's UI renders over HTTP; only its live push (GraphQL subscriptions)
  // needs a WebSocket. It embeds now; live-tail updates need the WS ingress rule.
  dagster: {
    key: 'dagster',
    title: 'Dagster',
    upstream: config.dagsterUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/dagster',
    minRole: 'builder',
    embeddable: true,
    sso: { mode: 'none' },
    note: 'HTTP UI embeds now; live subscriptions need the WS ingress path rule (prepared).',
  },

  // --- Documented, NOT HTTP-embeddable (status panel / native / WS-ingress) --
  jupyterhub: {
    key: 'jupyterhub',
    title: 'JupyterHub',
    upstream: config.jupyterhubUrl,
    protocol: 'ws',
    frame: 'strip',
    basePath: '/tools/jupyterhub',
    minRole: 'creator',
    embeddable: false,
    sso: { mode: 'header', userHeader: 'X-Forwarded-User' }, // RemoteUserAuthenticator
    note: 'Kernels/terminals need WebSockets — served via the ingress WS path rule, not this proxy.',
  },
  kserve: {
    key: 'kserve',
    title: 'KServe',
    upstream: config.kserveUrl,
    protocol: 'http',
    frame: 'strip',
    basePath: '/tools/kserve',
    minRole: 'builder',
    embeddable: false,
    sso: { mode: 'none' },
    note: 'Inference server — no human UI; render a status panel, never an iframe.',
  },
};

export function resolveTool(key: string): Tool | undefined {
  return Object.prototype.hasOwnProperty.call(TOOLS, key) ? TOOLS[key] : undefined;
}

/* ---------------------------------------------------------------- role gate */

/** True when `role` ranks at or above `minRole` (creator<builder<domain_admin<admin). */
export function roleAllowed(role: Role, minRole: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minRole);
}

/* ---------------------------------------------------- response transforms */

/** Strip any upstream `frame-ancestors` and pin it to `'self'` so only the OS shell may frame. */
export function rewriteCsp(csp: string): string {
  const kept = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/i.test(d));
  kept.push("frame-ancestors 'self'");
  return kept.join('; ');
}

/** Rewrite a redirect target so it stays inside the tool's `/tools/<key>` prefix. */
export function rewriteLocation(location: string, upstreamOrigin: string, basePath: string): string {
  if (location.startsWith(upstreamOrigin)) {
    const rest = location.slice(upstreamOrigin.length);
    return basePath + (rest.startsWith('/') ? rest : '/' + rest);
  }
  if (location.startsWith('/')) {
    return location.startsWith(basePath + '/') || location === basePath ? location : basePath + location;
  }
  return location; // relative or external — leave untouched
}

/** Move a Set-Cookie `Path=` under the tool prefix and drop `Domain=` (host-only on the OS origin). */
export function rewriteSetCookie(cookie: string, basePath: string): string {
  let out = cookie
    .split(';')
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && !/^domain=/i.test(a))
    .join('; ');
  if (/;\s*path=/i.test(out) || /^path=/i.test(out)) {
    out = out.replace(/(^|;\s*)path=\/?([^;]*)/i, (_m, pre, rest) => `${pre}Path=${basePath}/${rest}`);
  } else {
    out += `; Path=${basePath}/`;
  }
  return out;
}

/** Build the transformed response headers (frame-strip + CSP + Location + Set-Cookie). */
export function transformResponseHeaders(args: {
  headers: Headers;
  tool: Tool;
  upstreamOrigin: string;
  proto: string;
  host: string;
}): Headers {
  const { headers, tool, upstreamOrigin } = args;
  const out = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === 'x-frame-options') continue; // never let the tool forbid framing
    if (lower === 'set-cookie') continue; // handled below via getSetCookie()
    if (lower === 'content-security-policy') {
      out.set(name, rewriteCsp(value));
      continue;
    }
    if (lower === 'location') {
      out.set(name, rewriteLocation(value, upstreamOrigin, tool.basePath));
      continue;
    }
    out.set(name, value);
  }
  // Set-Cookie is multi-valued; getSetCookie() preserves each entry.
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of cookies) out.append('set-cookie', rewriteSetCookie(c, tool.basePath));
  return out;
}

/* ----------------------------------------------------- request / SSO headers */

// Hop-by-hop + identity-shadowing headers we never forward from the browser.
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  // Never let a client spoof the trusted-proxy identity headers.
  'x-forwarded-user',
  'x-forwarded-preferred-username',
  'x-forwarded-roles',
  'x-webauth-user',
]);

/** Remove the OS session cookie so it never reaches the upstream tool; keep the tool's own cookies. */
function filterCookies(cookie: string): string {
  return cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.startsWith(`${SESSION_COOKIE}=`))
    .join('; ');
}

/** Build the upstream request headers: forwarded chain + SSO injection. */
export function buildUpstreamHeaders(args: {
  tool: Tool;
  user: Principal;
  incoming: Headers;
  proto: string;
  host: string;
}): Headers {
  const { tool, user, incoming, proto, host } = args;
  const h = new Headers();
  for (const [name, value] of incoming) {
    if (DROP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'cookie') {
      const kept = filterCookies(value);
      if (kept) h.set('cookie', kept);
      continue;
    }
    h.set(name, value);
  }

  // Forwarded chain so the tool can build correct absolute URLs behind the prefix.
  h.set('x-forwarded-proto', proto);
  h.set('x-forwarded-host', host);
  h.set('x-forwarded-prefix', tool.basePath);

  if (tool.sso.mode === 'header') {
    h.set('x-forwarded-user', user.id);
    h.set('x-forwarded-preferred-username', user.id);
    if (tool.sso.userHeader && tool.sso.userHeader.toLowerCase() !== 'x-forwarded-user') {
      h.set(tool.sso.userHeader, user.id);
    }
    const role = tool.sso.roleMap?.[user.role] ?? user.role;
    h.set(tool.sso.rolesHeader ?? 'x-forwarded-roles', role);
  } else if (tool.sso.mode === 'basic' && tool.sso.basic) {
    const token = Buffer.from(`${tool.sso.basic.user}:${tool.sso.basic.pass}`).toString('base64');
    h.set('authorization', `Basic ${token}`);
  }
  return h;
}

/* --------------------------------------------------------------- the proxy */

/**
 * Server-side session establishment for `sso.mode:'session'` tools (Langfuse).
 * `active` answers "does the browser already carry a tool session?"; `provide`
 * mints one (full Set-Cookie strings) server-side. Kept as an injected seam so
 * lib/tool-proxy stays free of any one tool's auth specifics + is unit-testable.
 */
export type SessionSso = {
  active: (cookieHeader: string | null) => boolean;
  provide: () => Promise<string[]>;
};

/** `name=value` from a Set-Cookie string (attributes dropped) — for the Cookie request header. */
function setCookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0].trim();
}

/**
 * Reverse-proxy one request to a tool upstream and stream the response back with
 * the header transforms applied. `fetchImpl` is injectable for tests. For
 * session-SSO tools the caller passes `sessionSso`; when the browser has no tool
 * session yet, the proxy injects a server-minted one into BOTH this upstream
 * request and the browser response, so the console loads already logged-in.
 */
export async function proxy(
  req: Request,
  tool: Tool,
  pathSegments: string[],
  user: Principal,
  fetchImpl: typeof fetch = fetch,
  sessionSso?: SessionSso,
): Promise<Response> {
  const reqUrl = new URL(req.url);
  const host = req.headers.get('host') ?? reqUrl.host;
  const proto = req.headers.get('x-forwarded-proto') ?? reqUrl.protocol.replace(':', '');
  const upstreamOrigin = new URL(tool.upstream).origin;

  const path = pathSegments.map(encodeURIComponent).join('/');
  const target = `${tool.upstream}/${path}${reqUrl.search}`;

  const headers = buildUpstreamHeaders({ tool, user, incoming: req.headers, proto, host });
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  // Session SSO: mint + inject a tool session when the browser lacks one. On any
  // provider failure we inject nothing and forward as-is (the tool shows its own
  // login) — never a hard error.
  let injectedSetCookies: string[] = [];
  if (tool.sso.mode === 'session' && sessionSso && !sessionSso.active(req.headers.get('cookie'))) {
    const minted = await sessionSso.provide();
    if (minted.length > 0) {
      const pairs = minted.map(setCookiePair);
      const existing = headers.get('cookie');
      headers.set('cookie', [existing, ...pairs].filter(Boolean).join('; '));
      injectedSetCookies = minted;
    }
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    redirect: 'manual', // we rewrite Location ourselves
  };
  if (hasBody) {
    init.body = req.body;
    init.duplex = 'half'; // required by Node fetch when streaming a request body
  }

  const upstream = await fetchImpl(target, init as RequestInit);
  const outHeaders = transformResponseHeaders({
    headers: upstream.headers,
    tool,
    upstreamOrigin,
    proto,
    host,
  });
  // Persist the minted session on the browser (scoped to the tool prefix) so the
  // next /tools/<key> request carries it and we skip the server-side login.
  for (const c of injectedSetCookies) outHeaders.append('set-cookie', rewriteSetCookie(c, tool.basePath));
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}
