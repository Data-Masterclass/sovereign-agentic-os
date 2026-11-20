#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# check-secrets-not-defaults.py <rendered-manifest.yaml>
#
# Deploy preflight for "refuse development secret defaults in production (defence in depth)".
# From the manifest the upgrade will apply, find every guarded variable of os-ui, os-ui-worker
# and the LiteLLM gateway, resolve it the way the pod will (a literal `value`, a `secretKeyRef`
# to a Secret the render carries, otherwise the Secret already in the cluster, or a key of an
# `envFrom` Secret), and stop when one is missing or equals a public development default.
#
#   * READ-ONLY: the cluster is read with `$KUBECTL get secret <name> -o json` (KUBECTL is the full
#     command, e.g. "kubectl --context dmagenticos -n agentic-os"). Nothing is written.
#   * BY HASH ONLY: values are SHA-256 hashed in this process and compared with hmac.compare_digest
#     against the digests below — the same table as os-ui/core/kernel/secret-guard.ts (a unit test
#     keeps them equal). No value is printed; a finding names the workload, the variable, its
#     source (Secret/key) and the reason.
#   * The os-ui boot guard has a laptop exemption; this preflight does NOT: deploy.sh targets a
#     real cluster.
# Exit 0 = clean, 1 = findings (deploy must stop), 2 = could not check (deploy must stop too).
import base64, hashlib, hmac, json, os, shlex, subprocess, sys
import yaml

DIGESTS = {
    'LITELLM_MASTER_KEY': ['fadab17377ea25a99066f93f487fea827a9257e914131fa56bc92b84c520f5be'],
    'AGENT_RUNTIME_TOKEN': ['5d1730f0c23376d8e689f46b3160fbc409fd0e4c05186cef32013a618dd2bcc0',
                            '5ea8c27ca270109bb957d4b54b08e0adc2f8711df077efb0d59cc4b017db336b'],
    'OS_SESSION_SECRET': ['1397c0247256fdc8a257687a2e12674e6e65adfe04025e3c7ebbbc4c9e9a1dfc'],
    'OS_MCP_TOKEN_SECRET': ['1397c0247256fdc8a257687a2e12674e6e65adfe04025e3c7ebbbc4c9e9a1dfc'],
    'TERMINAL_BROKER_SECRET': ['020d317d047f4634439f77e23c67439639d4914fc0ad686b811403043118f9bd'],
    'LANGFUSE_PUBLIC_KEY': ['8ad181a220c5109ff0115e85250a33e13ba5f5cabcddb2f758f979f716724f6b'],
    'LANGFUSE_SECRET_KEY': ['aef69d589a481ddf96a3a68a4996c4c3f40be57ecd3bb12fe071dbc522ab9c28'],
}
# The gateway reads its master key as PROXY_MASTER_KEY (upstream chart); same secret, same digests.
ALIASES = {'PROXY_MASTER_KEY': 'LITELLM_MASTER_KEY'}

# workload -> (required variables, variables checked when present)
WORKLOADS = {
    'os-ui': (['LITELLM_MASTER_KEY', 'AGENT_RUNTIME_TOKEN', 'OS_SESSION_SECRET', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
              ['OS_MCP_TOKEN_SECRET', 'TERMINAL_BROKER_SECRET']),
    'os-ui-worker': (['AGENT_RUNTIME_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'], []),
    'agentic-os-litellm': (['PROXY_MASTER_KEY'], ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']),
}


def is_default(var, value):
    cand = hashlib.sha256(value.encode('utf-8')).hexdigest()
    hit = False
    for d in DIGESTS.get(ALIASES.get(var, var), []):
        hit = hmac.compare_digest(cand, d) or hit
    return hit


def main(path):
    kubectl = shlex.split(os.environ.get('KUBECTL', 'kubectl'))
    docs = [d for d in yaml.safe_load_all(open(path)) if isinstance(d, dict)]
    rendered = {d['metadata']['name']: d for d in docs if d.get('kind') == 'Secret' and d.get('metadata')}
    cache = {}

    def secret_data(name):
        """{key: str} for a Secret: the render's copy if it carries one, else the cluster's. None = absent."""
        if name in cache:
            return cache[name]
        out = None
        if name in rendered:
            s = rendered[name]
            out = {k: base64.b64decode(v).decode('utf-8', 'replace') for k, v in (s.get('data') or {}).items()}
            out.update({k: str(v) for k, v in (s.get('stringData') or {}).items()})
        else:
            r = subprocess.run(kubectl + ['get', 'secret', name, '-o', 'json'], capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip():
                try:
                    data = json.loads(r.stdout).get('data') or {}
                except ValueError:
                    print(f'   could not read Secret {name} (not JSON)', file=sys.stderr)
                    sys.exit(2)
                out = {k: base64.b64decode(v).decode('utf-8', 'replace') for k, v in data.items()}
            elif 'NotFound' not in (r.stderr or '') and r.returncode != 0:
                print(f'   could not read Secret {name}: kubectl exited {r.returncode}', file=sys.stderr)
                sys.exit(2)
        cache[name] = out
        return out

    findings, checked = [], 0
    deployments = {d['metadata']['name']: d for d in docs if d.get('kind') == 'Deployment' and d.get('metadata')}
    for wl, (required, optional) in WORKLOADS.items():
        dep = deployments.get(wl)
        if dep is None:
            continue
        containers = ((dep.get('spec') or {}).get('template') or {}).get('spec', {}).get('containers') or []
        env, env_from = {}, []
        for c in containers:
            for e in c.get('env') or []:
                env.setdefault(e['name'], e)
            for ef in c.get('envFrom') or []:
                if (ef.get('secretRef') or {}).get('name'):
                    env_from.append(ef['secretRef']['name'])
        if wl == 'os-ui' and str((env.get('TERMINAL_ENABLED') or {}).get('value', '')) == 'true':
            required = required + ['TERMINAL_BROKER_SECRET']
        for var in dict.fromkeys(required + optional):
            src, value = None, None
            e = env.get(var)
            if e is not None and 'value' in e:
                src, value = 'value', str(e.get('value') or '')
            elif e is not None and (e.get('valueFrom') or {}).get('secretKeyRef'):
                ref = e['valueFrom']['secretKeyRef']
                src = f"Secret {ref['name']}/{ref['key']}"
                data = secret_data(ref['name'])
                value = (data or {}).get(ref['key'], '')
            else:
                for name in env_from:
                    data = secret_data(name) or {}
                    if var in data:
                        src, value = f'Secret {name}/{var} (envFrom)', data[var]
                        break
            if src is None:
                if var in required and not (var == 'OS_MCP_TOKEN_SECRET'):
                    findings.append(f'{wl}: {var} is not set')
                continue
            checked += 1
            if value == '':
                if var in required:
                    findings.append(f'{wl}: {var} ({src}) is missing or empty')
            elif is_default(var, value):
                findings.append(f'{wl}: {var} ({src}) equals a public development default')
    for f in findings:
        print(f'   {f}')
    if findings:
        return 1
    print(f'   {checked} guarded values checked by hash: none missing, none equal a public development default')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: check-secrets-not-defaults.py <rendered-manifest.yaml>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
