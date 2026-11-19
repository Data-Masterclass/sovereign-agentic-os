/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    Live scenario runner — the pure parts (allowlists, path lookup, assertions, SQL guard)
 * USER STORY: As the owner I want to replay a small set of real scenarios against the live OS
 *             through its own MCP door after every deploy, and I want the runner itself to refuse
 *             any tool that could change data unless I explicitly opted in for a sandbox.
 * ARCHITECTURE:
 *   - No dependencies, no network: everything here is pure so `node --test` covers it.
 *   - Defence in depth: READ_ONLY_TOOLS is the runner's OWN allowlist (the server's role gate
 *     is the first door, this is the second). WRITE_TOOLS are only reachable with
 *     --allow-write + --sandbox-folder, from a scenario marked `requiresWrite`, and every
 *     write argument that names a folder must sit inside the sandbox. NEVER_TOOLS (approve,
 *     promote, decide, connection tests, re-index, sync) are refused in every mode.
 *   - Paths are a small JSONPath-like dialect: a.b[0].c, a[*].id, a[?name~=Invoice].id,
 *     a[?status=done], a.length. `[*]` and filters fan out into a list.
 */

export const READ_ONLY_TOOLS = Object.freeze([
  'whoami', 'list_capabilities', 'get_guide',
  'list_files', 'get_file', 'search_files',
  'list_knowledge', 'get_knowledge', 'search_knowledge',
  'list_datasets', 'get_dataset', 'profile_dataset', 'query_data',
  'list_metrics', 'get_metric', 'list_dashboards',
  'list_agent_systems', 'get_agent_system', 'get_agent_run', 'list_runs', 'get_run_trace',
  'list_connections', 'get_connection',
  'get_cost', 'get_monitoring_overview',
  'list_software', 'get_software',
]);

/** Writes a sandbox scenario may make, and only with --allow-write --sandbox-folder. */
export const WRITE_TOOLS = Object.freeze([
  'upload_file', 'delete', 'create_agent_system', 'commit_agent_files', 'build_agent_system',
  'run_agent_system', 'author_knowledge', 'retire_knowledge', 'archive',
]);

/** Refused in every mode: governance decisions, scope promotion, external side effects. */
export const NEVER_TOOLS = Object.freeze([
  'approve_promotion', 'decide_approval', 'decide_deploy', 'promote', 'promote_connection',
  'promote_metric', 'publish_knowledge', 'request_promotion', 'request_certification',
  'go_live', 'request_deploy', 'test_connection', 'configure_connection', 'create_connection',
  'retire_connection', 'reindex_corpus', 'index_knowledge', 'sync_dataset_now', 'set_dataset_sync',
  'refresh_connection_catalog', 'update_operating_manual', 'restore_operating_manual_version',
  'import_okf_bundle', 'reconcile_domain_tables', 'classify_catalog',
]);

const SANDBOX_ARG_KEYS = ['folder', 'path', 'targetFolder', 'outputFolder'];

/**
 * Decide whether a step may call `tool`. Returns { ok: true } or { ok: false, reason }.
 * opts: { allowWrite, sandboxFolder, scenarioRequiresWrite, createdIds }
 */
export function checkToolAllowed(tool, args = {}, opts = {}) {
  if (typeof tool !== 'string' || !tool) return { ok: false, reason: 'step has no tool name' };
  if (NEVER_TOOLS.includes(tool)) return { ok: false, reason: `${tool} is never allowed by this runner` };
  if (READ_ONLY_TOOLS.includes(tool)) {
    if (tool === 'query_data') {
      const g = guardSql(args?.sql);
      if (!g.ok) return g;
    }
    return { ok: true };
  }
  if (!WRITE_TOOLS.includes(tool)) return { ok: false, reason: `${tool} is not on the runner allowlist` };
  if (!opts.allowWrite) return { ok: false, reason: `${tool} writes; refused in --read-only mode` };
  if (!opts.scenarioRequiresWrite) return { ok: false, reason: `${tool} writes but the scenario is not marked requiresWrite` };
  const sandbox = normFolder(opts.sandboxFolder);
  if (!sandbox || sandbox === '/') return { ok: false, reason: 'writes need --sandbox-folder (not "/")' };
  for (const k of SANDBOX_ARG_KEYS) {
    if (args && typeof args[k] === 'string' && !isUnder(sandbox, normFolder(args[k]))) {
      return { ok: false, reason: `${tool}.${k}="${args[k]}" is outside the sandbox ${sandbox}` };
    }
  }
  if (tool === 'upload_file' && typeof args?.folder !== 'string') {
    return { ok: false, reason: 'upload_file must name a folder inside the sandbox' };
  }
  // A system.yaml may only name folders inside the sandbox (grants, outputs).
  if (tool === 'commit_agent_files') {
    const texts = [args?.content, ...(Array.isArray(args?.files) ? args.files.map((f) => f?.content) : [])].filter((t) => typeof t === 'string');
    for (const t of texts) {
      for (const m of t.matchAll(/\bpath:\s*['"]?(\/[^'"\s]*)/g)) {
        if (!isUnder(sandbox, normFolder(m[1]))) return { ok: false, reason: `system.yaml names folder ${m[1]} outside the sandbox` };
      }
      if (/\bscope:\s*['"]?domain/i.test(t)) return { ok: false, reason: 'system.yaml grants a Domain folder; sandbox runs stay in My scope' };
    }
  }
  // Acting on an existing object (build, run, commit, retire) only on one THIS run created.
  const target = args?.systemId ?? args?.workflowId ?? args?.fileId;
  if (['commit_agent_files', 'build_agent_system', 'run_agent_system', 'retire_knowledge', 'delete', 'archive'].includes(tool)) {
    const id = target ?? args?.appId;
    if (!id || !(opts.createdIds || []).includes(id)) return { ok: false, reason: `${tool} may only act on an object this run created` };
  }
  if (args && typeof args.domain === 'string' && opts.sandboxDomain && args.domain !== opts.sandboxDomain) {
    return { ok: false, reason: `${tool} domain "${args.domain}" is not the sandbox domain ${opts.sandboxDomain}` };
  }
  if (args && args.scope && !['my', 'personal'].includes(String(args.scope).toLowerCase())) {
    return { ok: false, reason: `${tool} scope "${args.scope}" — sandbox writes stay in My scope` };
  }
  return { ok: true };
}

export function normFolder(f) {
  if (typeof f !== 'string') return '';
  const s = '/' + f.trim().replace(/^\/+|\/+$/g, '');
  return s.toLowerCase();
}
export function isUnder(root, f) {
  return f === root || f.startsWith(root + '/');
}

/** query_data guard: one SELECT/WITH statement, and a LIMIT <= 100 unless it only aggregates. */
export function guardSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return { ok: false, reason: 'query_data needs sql' };
  const s = sql.trim().replace(/;\s*$/, '');
  if (s.includes(';')) return { ok: false, reason: 'query_data: one statement only' };
  if (!/^(select|with)\b/i.test(s)) return { ok: false, reason: 'query_data: SELECT/WITH only' };
  if (/\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|call)\b/i.test(s.replace(/'[^']*'/g, "''"))) {
    return { ok: false, reason: 'query_data: a write keyword appears in the SQL' };
  }
  const lim = /\blimit\s+(\d+)\s*$/i.exec(s);
  const aggregateOnly = /^select\s+(count|sum|min|max|avg)\s*\(/i.test(s) && !/\bgroup\s+by\b/i.test(s);
  if (!aggregateOnly && (!lim || Number(lim[1]) > 100)) return { ok: false, reason: 'query_data: needs LIMIT <= 100 (or a single aggregate)' };
  return { ok: true };
}

// ---------------------------------------------------------------- paths
function tokenize(path) {
  const out = [];
  const re = /\.?([A-Za-z_$][\w$-]*)|\[(\d+|\*|\?[^\]]+)\]/g;
  let m;
  let i = 0;
  while ((m = re.exec(path))) {
    if (m.index !== i) throw new Error(`bad path "${path}" at ${i}`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ key: m[1] });
    else if (m[2] === '*') out.push({ all: true });
    else if (m[2].startsWith('?')) {
      const f = /^\?([\w.$-]+)\s*(~=|!=|=)\s*(.*)$/.exec(m[2]);
      if (!f) throw new Error(`bad filter in "${path}"`);
      out.push({ filter: { key: f[1], op: f[2], value: f[3].replace(/^["']|["']$/g, '') } });
    } else out.push({ index: Number(m[2]) });
  }
  if (i !== path.length) throw new Error(`bad path "${path}"`);
  return out;
}

const getDot = (o, k) => k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), o);

/**
 * Resolve a path. Returns { found, value, multi }. With a fan-out (`[*]`, filter) the value
 * is an array of every match and `multi` is true.
 */
export function evalPath(obj, path) {
  if (path === '' || path === '$' || path == null) return { found: obj !== undefined, value: obj, multi: false };
  // `a.0.b` and a bare `0` are accepted as `a[0].b` / `[0]`.
  const norm = String(path).replace(/^\$\.?/, '').replace(/^(\d+)/, '[$1]').replace(/\.(\d+)(?=[.[]|$)/g, '[$1]');
  const toks = tokenize(norm);
  let cur = [obj];
  let multi = false;
  for (const t of toks) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (t.key !== undefined) {
        if (t.key === 'length' && (Array.isArray(c) || typeof c === 'string')) next.push(c.length);
        else if (typeof c === 'object' && t.key in c) next.push(c[t.key]);
      } else if (t.index !== undefined) {
        if (Array.isArray(c) && t.index < c.length) next.push(c[t.index]);
      } else if (t.all) {
        multi = true;
        if (Array.isArray(c)) next.push(...c);
        else if (typeof c === 'object') next.push(...Object.values(c));
      } else if (t.filter) {
        multi = true;
        if (!Array.isArray(c)) continue;
        for (const el of c) {
          const v = getDot(el, t.filter.key);
          const want = t.filter.value;
          const hit =
            t.filter.op === '='
              ? String(v) === want
              : t.filter.op === '!='
                ? String(v) !== want
                : typeof v === 'string' && v.toLowerCase().includes(want.toLowerCase());
          if (hit) next.push(el);
        }
      }
    }
    cur = next;
  }
  if (multi) return { found: true, value: cur, multi };
  return { found: cur.length > 0, value: cur[0], multi };
}

// ---------------------------------------------------------------- assertions
const asNum = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/**
 * One assertion against a parsed response. a = { path, op, value?, label? }.
 * ops: exists · absent · equals · notEquals · gte · lte · contains · containsAny · notContains ·
 *      matches · type · nonEmpty · allEqual (every fan-out value equals `value`) ·
 *      containsAll (the fan-out list holds every name in `value`) · anyGt · allNonEmpty ·
 *      backtickedNamesIn (every `snake_case` name in backticks in the text is one of `value`)
 * Modifiers: `soft: true` (a miss is a warning, e.g. a feature merged but not yet deployed) and
 *            `when: { path, equals }` (applies only when another field has that value).
 * Returns { ok, label, detail } — `detail` never carries response content, only sizes/types.
 */
export function runAssertion(resp, a) {
  const out = runAssertionRaw(resp, a);
  return a.soft ? { ...out, soft: true } : out;
}

function runAssertionRaw(resp, a) {
  const label = a.label || `${a.path ?? '$'} ${a.op}${a.value !== undefined ? ' ' + JSON.stringify(a.value) : ''}`;
  // `when: { path, equals }` — the assertion only applies when that other field has that value.
  if (a.when && evalPath(resp, a.when.path).value !== a.when.equals) return { ok: true, label, detail: 'not applicable', skipped: true };
  let r;
  try {
    r = evalPath(resp, a.path ?? '');
  } catch (e) {
    return { ok: false, label, detail: String(e.message) };
  }
  const v = r.value;
  const present = r.multi ? Array.isArray(v) && v.length > 0 : r.found && v !== undefined && v !== null;
  const describe = () =>
    Array.isArray(v) ? `array(${v.length})` : v === undefined ? 'missing' : typeof v === 'string' ? `string(${v.length})` : typeof v === 'object' && v ? 'object' : String(v);
  let ok;
  switch (a.op) {
    case 'exists': ok = present; break;
    case 'absent': ok = !present; break;
    case 'nonEmpty':
      ok = present && (typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : typeof v === 'object' ? Object.keys(v).length > 0 : true);
      break;
    case 'equals': ok = r.multi ? v.length === 1 && v[0] === a.value : v === a.value; break;
    case 'notEquals': ok = v !== a.value; break;
    case 'allEqual': ok = Array.isArray(v) && v.length > 0 && v.every((x) => x === a.value); break;
    case 'gte': ok = asNum(v) >= a.value; break;
    case 'lte': ok = asNum(v) <= a.value; break;
    case 'contains': ok = present && asText(v).toLowerCase().includes(String(a.value).toLowerCase()); break;
    case 'containsAny': ok = present && (a.value || []).some((x) => asText(v).toLowerCase().includes(String(x).toLowerCase())); break;
    case 'notContains': ok = !asText(v).toLowerCase().includes(String(a.value).toLowerCase()); break;
    case 'matches': ok = present && new RegExp(a.value).test(asText(v)); break;
    case 'containsAll': {
      const have = new Set((Array.isArray(v) ? v : []).map(String));
      const missing = (a.value || []).filter((x) => !have.has(String(x)));
      return { ok: missing.length === 0, label, detail: missing.length ? `missing: ${missing.join(', ')}` : '' };
    }
    case 'backtickedNamesIn': {
      const known = new Set((a.value || []).map(String));
      const named = [...new Set([...asText(v).matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\(|`)/g)].map((m) => m[1]))];
      const unknown = named.filter((n) => !known.has(n) && !(a.ignore || []).includes(n));
      return { ok: unknown.length === 0, label, detail: unknown.length ? `not a tool: ${unknown.join(', ')}` : '', count: named.length };
    }
    case 'anyGt': ok = Array.isArray(v) && v.some((x) => typeof x === 'number' && x > a.value); break;
    case 'allNonEmpty': ok = Array.isArray(v) && v.length > 0 && v.every((x) => (typeof x === 'string' ? x.trim().length > 0 : x != null)); break;
    case 'type': ok = a.value === 'array' ? Array.isArray(v) : typeof v === a.value; break;
    default: return { ok: false, label, detail: `unknown op ${a.op}` };
  }
  return { ok: !!ok, label, detail: ok ? '' : `got ${describe()}` };
}

/** Substitute ${var} (and ${var.path}) from the run's saved variables. */
export function substitute(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole) return lookupVar(whole[1], vars);
    return value.replace(/\$\{([^}]+)\}/g, (_, k) => {
      const v = lookupVar(k, vars);
      return v === undefined ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((x) => substitute(x, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, substitute(x, vars)]));
  return value;
}
function lookupVar(k, vars) {
  const [head, ...rest] = k.split('.');
  const base = vars[head];
  return rest.length ? evalPath(base, rest.join('.')).value : base;
}

export function latencyStats(ms) {
  const xs = ms.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!xs.length) return { n: 0, min: null, median: null, p90: null, max: null };
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const median = xs.length % 2 ? xs[(xs.length - 1) / 2] : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  return { n: xs.length, min: xs[0], median, p90: q(0.9), max: xs[xs.length - 1] };
}

/** Parse an MCP tools/call JSON-RPC response into { data, errorCode, isError, size }. */
export function parseToolResponse(rpc) {
  if (!rpc || typeof rpc !== 'object') return { data: null, isError: true, errorCode: 'no_response', size: 0 };
  if (rpc.error) return { data: null, isError: true, errorCode: `rpc_${rpc.error.code}`, size: 0, reason: rpc.error.message };
  const res = rpc.result ?? {};
  const text = Array.isArray(res.content) ? res.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : '';
  let data = text;
  try {
    data = text ? JSON.parse(text) : res.structuredContent ?? null;
  } catch {
    /* plain-text result */
  }
  const err = res.isError ? res.structuredContent?.error ?? data?.error ?? {} : null;
  return { data, isError: !!res.isError, errorCode: err ? err.code || 'tool_error' : null, reason: err?.reason, size: text.length };
}

/** A shape of a value with NO content: keys, types and array lengths only (for --shape probes). */
export function shapeOf(v, depth = 0, max = 4) {
  if (Array.isArray(v)) return v.length ? [`len=${v.length}`, shapeOf(v[0], depth + 1, max)] : ['len=0'];
  if (v && typeof v === 'object') {
    if (depth >= max) return '{…}';
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shapeOf(x, depth + 1, max)]));
  }
  if (typeof v === 'string') return `str(${v.length})`;
  return typeof v;
}

/**
 * A recorded value: a plain path, or a small derivation over a fan-out —
 * { span: path } (max - min), { sum: path }, { distinct: path } (sorted unique short strings).
 */
export function recordValue(data, spec) {
  if (typeof spec === 'string') {
    const v = evalPath(data, spec).value;
    return Array.isArray(v) ? v.length : v;
  }
  const [kind, path] = Object.entries(spec)[0];
  const xs = [].concat(evalPath(data, path).value ?? []);
  if (kind === 'span') { const ns = xs.filter((x) => typeof x === 'number'); return ns.length ? Math.max(...ns) - Math.min(...ns) : undefined; }
  if (kind === 'sum') return xs.filter((x) => typeof x === 'number').reduce((a, b) => a + b, 0);
  if (kind === 'distinct') return [...new Set(xs.filter((x) => typeof x === 'string' && x.length <= 40))].sort().join(',');
  return undefined;
}
