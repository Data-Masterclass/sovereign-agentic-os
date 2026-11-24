# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""gateway_live.py — read (and, for `migrate --apply`, write) a LIVE LiteLLM gateway from INSIDE its pod.

Run by scripts/gateway/lib.mjs as `kubectl exec deploy/<rel>-litellm -c litellm -- python3 -c <this file> <cmd> ...`,
so the master key never leaves the pod: it is read from the container's own PROXY_MASTER_KEY and used only in
the Authorization header of requests to http://localhost:4000. Standard library only (the LiteLLM image has
no extra packages for us).

NEVER PRINTS A SECRET. Every output is built from an ALLOWLIST of fields (model, provider, api_base, limits,
prices, supports_* flags, mode); an api_key, a credential name's value, a virtual key or a token is never
copied into the output. Model ids (`model_info.id`) are printed only by `migrate` (what it created).

  catalog              the live catalog: {"aliases": {alias: model}, "models": {name: [deployment...]}}, each
                       deployment {"db": bool, "params": {...}, "info": {...}} with allowlisted fields only.
  preflight [--ignore <name>]...
                       what the gateway REFERENCES that is not a database model: the role-alias targets
                       (router_settings.model_group_alias), every virtual key's `models`, and every model that
                       still comes from the config file. {"missing": [{"name", "referenced_by": [...]}], ...}
  migrate <b64> [--apply]
                       <b64> = base64 JSON list of config `model_list` entries (as in the ConfigMap: env
                       references, never a key). For each name with no database row: plan (default) or create
                       (--apply) a database row with the same litellm_params and model_info (prices copied into
                       litellm_params too: LiteLLM 1.109.1 keeps a database row's price only there). An
                       `api_key` must be an `os.environ/...` reference — the row then reads the same variable
                       the config did (measured on 1.109.1); a literal key is NEVER copied: that model is
                       reported `needs_key_in_ui`. Idempotent: a name that already has a database row is
                       `present` (with any difference in model / api_base listed) and never touched.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get('GATEWAY_URL', 'http://localhost:4000')
PARAM_KEYS = ('model', 'custom_llm_provider', 'api_base', 'api_version', 'reasoning_effort', 'timeout',
              'stream_timeout', 'max_retries', 'extra_body', 'rpm', 'tpm', 'order',
              'input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost')
INFO_KEYS = ('mode', 'max_input_tokens', 'max_output_tokens', 'max_tokens', 'output_vector_size',
             'input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost',
             'cache_creation_input_token_cost', 'access_groups')
PRICE_KEYS = ('input_cost_per_token', 'output_cost_per_token', 'cache_read_input_token_cost')
SKIP_REFS = {'*', 'all-proxy-models', 'all-team-models', 'no-default-models'}


def _req(method, path, body=None, timeout=20):
    key = os.environ.get('PROXY_MASTER_KEY', '')
    if not key:
        raise SystemExit(json.dumps({'error': 'PROXY_MASTER_KEY is not set in this container'}))
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read() or b'null')


def _clean(d, keys):
    out = {}
    for k in keys:
        v = (d or {}).get(k)
        if v is None or v == '' or v == [] or v == {}:
            continue
        out[k] = v
    return out


def _flags(info):
    return {k: v for k, v in sorted((info or {}).items()) if k.startswith('supports_') and isinstance(v, bool)}


def rows():
    return (_req('GET', '/model/info') or {}).get('data') or []


class Unreadable(Exception):
    """A part of the gateway could not be read: the caller must not treat it as empty."""


def aliases():
    """The role aliases (router_settings.model_group_alias). NEVER guessed: an error is Unreadable, because an
    empty answer here would leave every alias target unchecked by the preflight and the parity check."""
    try:
        r = _req('GET', '/router/settings') or {}
    except Exception as e:
        raise Unreadable('GET /router/settings failed: %s' % type(e).__name__ + (' %s' % getattr(e, 'code', '') if getattr(e, 'code', None) else ''))
    cv = r.get('current_values')
    if not isinstance(cv, dict):
        raise Unreadable('GET /router/settings answered without current_values')
    return dict(cv.get('model_group_alias') or {})


def full_model(lp):
    """`<provider>/<model>` however it was entered: the UI stores `model` + `custom_llm_provider` separately,
    a config file writes `openai/<model>`. Both mean the same upstream, so both normalise to one string."""
    m, prov = str((lp or {}).get('model') or ''), (lp or {}).get('custom_llm_provider')
    if prov and not m.startswith(str(prov) + '/'):
        return '%s/%s' % (prov, m)
    return m


def deployment(row):
    lp, mi = row.get('litellm_params') or {}, row.get('model_info') or {}
    params = _clean(lp, PARAM_KEYS)
    params.pop('custom_llm_provider', None)
    if lp.get('model'):
        params['model'] = full_model(lp)
    info = _clean(mi, INFO_KEYS)
    info.update(_flags(mi))
    # Prices: LiteLLM 1.109.1 stamps a row's litellm_params prices into /model/info's model_info
    # (proxy_server.py `_pricing_override_stamps`), but a row may carry them in either place. One place for the
    # comparison: model_info, taken from litellm_params where model_info has none.
    for k in PRICE_KEYS:
        v = params.pop(k, None)
        if info.get(k) is None and v is not None:
            info[k] = v
    return {'db': mi.get('db_model') is True, 'params': params, 'info': info}


def split_aliases(rs, al):
    """LiteLLM 1.109.1 lists every alias as a row that REPEATS its target's deployment (same model_info.id).
    Such an echo is not a model. A row named like an alias that is NOT an echo of its target is a real model
    that shares a name with an alias — a conflict, reported, never hidden."""
    ids = {}
    for r in rs:
        if r.get('model_name') not in al:
            ids.setdefault(r.get('model_name'), set()).add((r.get('model_info') or {}).get('id'))
    real, conflicts = [], set()
    for r in rs:
        name = r.get('model_name')
        if name in al:
            if (r.get('model_info') or {}).get('id') not in ids.get(al[name], set()):
                conflicts.add(name)
            continue
        real.append(r)
    return real, sorted(conflicts)


def cmd_catalog():
    al = aliases()
    real, conflicts = split_aliases(rows(), al)
    models = {}
    for r in real:
        name = r.get('model_name')
        if not isinstance(name, str):
            continue
        models.setdefault(name, []).append(deployment(r))
    for name in models:
        models[name].sort(key=lambda d: json.dumps(d, sort_keys=True))
    print(json.dumps({'aliases': dict(sorted(al.items())), 'alias_conflicts': conflicts,
                      'models': dict(sorted(models.items()))}, sort_keys=True))


def key_models():
    """{model name -> [key alias...]} over every virtual key (paged, 100 per page). Key VALUES are never read out."""
    refs, page = {}, 1
    while True:
        q = urllib.parse.urlencode({'return_full_object': 'true', 'include_team_keys': 'true', 'size': 100, 'page': page})
        r = _req('GET', '/key/list?' + q) or {}
        for k in r.get('keys') or []:
            if not isinstance(k, dict):
                continue
            label = k.get('key_alias') or k.get('key_name') or '(unnamed key)'
            for m in k.get('models') or []:
                refs.setdefault(m, []).append('key ' + str(label))
        if page >= int(r.get('total_pages') or 1):
            return refs
        page += 1


def cmd_preflight(ignore=()):
    rs, al = rows(), aliases()
    db, config, groups = set(), set(), set(ignore)
    for r in rs:
        name = r.get('model_name')
        mi = r.get('model_info') or {}
        groups.update(mi.get('access_groups') or [])
        if name in al:
            continue
        (db if mi.get('db_model') is True else config).add(name)
    refs = {}
    for alias, target in al.items():
        refs.setdefault(target, []).append('alias ' + alias)
    for m, who in key_models().items():
        refs.setdefault(m, []).extend(who)
    for m in config:
        refs.setdefault(m, []).append('config file')
    missing = []
    for m, who in sorted(refs.items()):
        if m in db or m in al or m in groups or m in SKIP_REFS:
            continue
        missing.append({'name': m, 'referenced_by': sorted(set(who))[:12]})
    print(json.dumps({'missing': missing, 'config_models': sorted(config), 'db_models': sorted(db),
                      'aliases': len(al)}, sort_keys=True))


def cmd_migrate(b64, apply):
    entries = json.loads(base64.b64decode(b64).decode())
    live = {}
    for r in rows():
        if (r.get('model_info') or {}).get('db_model') is True:
            live.setdefault(r.get('model_name'), []).append(r)
    report = []
    for e in entries:
        name = e.get('model_name')
        lp = dict(e.get('litellm_params') or {})
        mi = dict(e.get('model_info') or {})
        key = lp.get('api_key')
        item = {'name': name}
        if name in live:
            d = live[name][0].get('litellm_params') or {}
            diff = []
            if full_model(d) != full_model(lp):
                diff.append('model')
            want_base = lp.get('api_base')
            if isinstance(want_base, str) and want_base.startswith('os.environ/'):
                want_base = os.environ.get(want_base[len('os.environ/'):])
            if want_base and d.get('api_base') and d.get('api_base').rstrip('/') != want_base.rstrip('/'):
                diff.append('api_base')
            item.update(action='present', differs=diff)
        elif key is not None and not (isinstance(key, str) and key.startswith('os.environ/')):
            item.update(action='needs_key_in_ui', reason='the config holds a literal api_key; it is never copied — create this model in the LiteLLM UI and type the key there')
        else:
            for p in PRICE_KEYS:
                if p in mi and p not in lp:
                    lp[p] = mi[p]
            body = {'model_name': name, 'litellm_params': lp, 'model_info': mi}
            if apply:
                r = _req('POST', '/model/new', body) or {}
                item.update(action='created', id=r.get('model_id'))
            else:
                item.update(action='would_create')
        report.append(item)
    print(json.dumps({'applied': apply, 'models': report}, sort_keys=True))


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ''
    if cmd == 'catalog':
        cmd_catalog()
    elif cmd == 'preflight':
        # --ignore <name>: a name keys may list that is not a model (the chart's LiteLLM access group).
        cmd_preflight([args[i + 1] for i, a in enumerate(args) if a == '--ignore' and i + 1 < len(args)])
    elif cmd == 'migrate' and len(args) >= 2:
        cmd_migrate(args[1], '--apply' in args[2:])
    else:
        raise SystemExit('usage: gateway_live.py catalog | preflight [--ignore <name>]... | migrate <b64> [--apply]')


if __name__ == '__main__':
    try:
        main()
    except Unreadable as e:
        sys.stderr.write('GATEWAY_UNREADABLE: %s\n' % e)
        sys.exit(3)
    except urllib.error.URLError as e:  # HTTPError included; only the status/reason, never headers or a body
        sys.stderr.write('GATEWAY_UNREADABLE: %s %s\n' % (type(e).__name__, getattr(e, 'code', '') or getattr(e, 'reason', '')))
        sys.exit(3)
