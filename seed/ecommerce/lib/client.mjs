/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Data Masterclass
 *
 * Tiny governed-API client for the e-commerce seed. Zero dependencies — uses the
 * Node 22 global `fetch`. It NEVER bypasses governance: it authenticates against
 * the same `POST /api/auth/login` the browser uses, holds the resulting signed
 * `soa_session` cookie, and presents it on every governed call. OPA / RLS / audit
 * therefore apply exactly as for a human in that role.
 */

const SESSION_COOKIE = 'soa_session';

/** One signed-in identity (a member of the seeded cast). Holds its own cookie. */
export class Session {
  /** @param {string} baseUrl @param {string} id */
  constructor(baseUrl, id) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.id = id;
    this.cookie = '';
    this.user = null;
  }

  /** Authenticate with seeded credentials → capture the signed session cookie. */
  async login(password) {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.id, password }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`login failed for ${this.id} [${res.status}] ${body}`);
    }
    // Node exposes multiple Set-Cookie via getSetCookie(); find the session one.
    const cookies = res.headers.getSetCookie?.() ?? [];
    const sc = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!sc) throw new Error(`login for ${this.id}: no ${SESSION_COOKIE} cookie returned`);
    this.cookie = sc.split(';')[0];
    this.user = (await res.json()).user;
    return this.user;
  }

  /** A governed request carrying this identity's session. Returns {status, body}. */
  async req(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: this.cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }

  get(path) {
    return this.req('GET', path);
  }
  post(path, body) {
    return this.req('POST', path, body);
  }
  put(path, body) {
    return this.req('PUT', path, body);
  }
  patch(path, body) {
    return this.req('PATCH', path, body);
  }

  /** POST and throw on a non-2xx — for steps whose failure should abort a chain. */
  async postOk(path, body) {
    const r = await this.post(path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`POST ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body;
  }
}

/**
 * A minimal step runner. Each step is logged with a ✓/✗ and a one-line note; a
 * failing step is recorded but does NOT abort the whole seed (so a single
 * unreachable backend on kind doesn't hide the rest of the narrative). The final
 * summary is the seed's test evidence.
 */
export class Runner {
  constructor() {
    this.results = [];
  }

  async step(tab, name, fn) {
    const started = Date.now();
    try {
      const note = await fn();
      const ms = Date.now() - started;
      this.results.push({ tab, name, ok: true, note: note ?? '', ms });
      console.log(`  ✓ [${tab}] ${name}${note ? ` — ${note}` : ''} (${ms}ms)`);
      return { ok: true, note };
    } catch (e) {
      const ms = Date.now() - started;
      const msg = e instanceof Error ? e.message : String(e);
      this.results.push({ tab, name, ok: false, note: msg, ms });
      console.log(`  ✗ [${tab}] ${name} — ${msg} (${ms}ms)`);
      return { ok: false, error: msg };
    }
  }

  summary() {
    const ok = this.results.filter((r) => r.ok).length;
    const fail = this.results.length - ok;
    return { total: this.results.length, ok, fail, results: this.results };
  }
}

/** Resolve the OS UI base URL (in-cluster Service default; override for local). */
export function baseUrlFromEnv() {
  return (process.env.OS_UI_URL || 'http://os-ui:3000').replace(/\/+$/, '');
}
