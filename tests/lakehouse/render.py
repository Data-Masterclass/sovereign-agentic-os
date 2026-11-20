#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Render the chart and write out what the lakehouse harness containers need (WP-13, 06 §7.1).

    python3 tests/lakehouse/render.py <out-dir> [extra helm args ...]

`helm template` with tests/lakehouse/ci-values.yaml. Nothing here re-types the chart: images,
config files, container commands and env all come from the rendered Deployments and Jobs, so the
harness runs the config that ships. Writes:

  compose.env                 image refs + OPA args, read by `docker compose --env-file`
  trino/etc/...               every file the Trino Deployment mounts, at its mount path under /etc/trino
  opa/<mount>/...             the OPA Deployment's ConfigMaps, at their mount paths
  env/<container>.env         each container's env, secretKeyRefs resolved from the harness secrets
  sh/<container>.sh           the `sh -c` script of each scripted container (Polaris bootstrap, catalog init)

The secrets the chart expects from outside (object store keys, the Polaris JDBC user) are
generated per run by up.sh and passed in through the environment; they exist only in this stack.
"""
import json
import os
import subprocess
import sys

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHART = os.path.join(ROOT, 'charts', 'sovereign-agentic-os')
CI = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ci-values.yaml')

# Where compose.yaml mounts things. A chart change that moves them must fail here, loudly.
OPA_MOUNTS = {'/policies', '/config'}


def render(extra):
    out = subprocess.run(
        ['helm', 'template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', '-f', CI, *extra],
        check=True, capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def find(docs, kind, name):
    for d in docs:
        if d.get('kind') == kind and d.get('metadata', {}).get('name') == name:
            return d
    raise SystemExit(f'render.py: {kind}/{name} not rendered')


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def secrets(docs):
    """Chart-rendered Secrets (local profile) plus the harness-generated external ones."""
    s = {}
    for d in docs:
        if d.get('kind') == 'Secret':
            s[d['metadata']['name']] = dict(d.get('stringData') or {})
    need = {
        'object-storage-credentials': {'AWS_ACCESS_KEY_ID': 'LH_S3_KEY', 'AWS_SECRET_ACCESS_KEY': 'LH_S3_SECRET'},
        'postgres-polaris-credentials': {'username': 'LH_PG_USER', 'password': 'LH_PG_PASSWORD'},
    }
    for name, keys in need.items():
        s.setdefault(name, {})
        for key, var in keys.items():
            if not os.environ.get(var):
                raise SystemExit(f'render.py: {var} must be set (up.sh generates it)')
            s[name][key] = os.environ[var]
    return s


def env_file(ctr, sec):
    lines = []
    for e in ctr.get('env', []):
        if 'value' in e:
            val = str(e['value'])
        else:
            ref = e['valueFrom']['secretKeyRef']
            try:
                val = sec[ref['name']][ref['key']]
            except KeyError:
                raise SystemExit(f"render.py: {ctr['name']} needs secret {ref['name']}/{ref['key']}, not available")
        if '\n' in val:
            raise SystemExit(f"render.py: env {e['name']} is multi-line")
        lines.append(f"{e['name']}={val}")
    return '\n'.join(lines) + '\n'


def script(ctr):
    cmd = ctr.get('command') or []
    if cmd != ['/bin/sh', '-c']:
        raise SystemExit(f"render.py: {ctr['name']} is not a `/bin/sh -c` container: {cmd}")
    return ctr['args'][0]


def materialise(pod, ctr, cms, base, strip=''):
    """Write each ConfigMap-backed mount of `ctr` under `base`, at its mount path minus `strip`."""
    vols = {v['name']: v for v in pod.get('volumes', [])}
    for vm in ctr.get('volumeMounts', []):
        vol = vols[vm['name']]
        if 'configMap' not in vol:
            continue  # emptyDir: compose gives a tmpfs
        data = cms[vol['configMap']['name']]['data']
        rel = vm['mountPath'][len(strip):].lstrip('/') if strip else vm['mountPath'].lstrip('/')
        if vm.get('subPath'):
            write(os.path.join(base, rel), data[vm['subPath']])
        else:
            for key, val in data.items():
                write(os.path.join(base, rel, key), val)


def main(out, extra):
    docs = render(extra)
    cms = {d['metadata']['name']: d for d in docs if d.get('kind') == 'ConfigMap'}
    sec = secrets(docs)
    env = {}

    # Trino: every mounted file at its path under /etc/trino.
    tpod = find(docs, 'Deployment', 'trino')['spec']['template']['spec']
    trino = next(c for c in tpod['containers'] if c['name'] == 'trino')
    for vm in trino['volumeMounts']:
        if not (vm['mountPath'].startswith('/etc/trino') or vm['mountPath'] in ('/data/trino', '/tmp')):
            raise SystemExit(f"render.py: unexpected Trino mount {vm['mountPath']}")
    materialise(tpod, trino, cms, os.path.join(out, 'trino', 'etc'), strip='/etc/trino')
    write(os.path.join(out, 'env', 'trino.env'), env_file(trino, sec))
    env['LH_TRINO_IMAGE'] = trino['image']

    # OPA: the policies and config the chart mounts, and its exact args.
    opod = find(docs, 'Deployment', 'opa')['spec']['template']['spec']
    opa = next(c for c in opod['containers'] if c['name'] == 'opa')
    mounts = {vm['mountPath'] for vm in opa['volumeMounts']}
    if mounts != OPA_MOUNTS:
        raise SystemExit(f'render.py: OPA mounts changed to {sorted(mounts)}; update compose.yaml')
    materialise(opod, opa, cms, os.path.join(out, 'opa'))
    if any(' ' in a for a in opa['args']):
        raise SystemExit('render.py: an OPA arg contains a space')
    env['LH_OPA_IMAGE'] = opa['image']
    env['LH_OPA_ARGS'] = ' '.join(opa['args'])

    # Polaris: the two bootstrap initContainers and the server, as the chart runs them.
    ppod = find(docs, 'Deployment', 'polaris')['spec']['template']['spec']
    inits = {c['name']: c for c in ppod.get('initContainers', [])}
    if set(inits) != {'bootstrap-check', 'bootstrap'}:
        raise SystemExit(f'render.py: Polaris initContainers changed: {sorted(inits)}')
    for name, c in inits.items():
        write(os.path.join(out, 'env', f'polaris-{name}.env'), env_file(c, sec))
        write(os.path.join(out, 'sh', f'polaris-{name}.sh'), script(c))
    env['LH_PG_IMAGE'] = inits['bootstrap-check']['image']
    env['LH_POLARIS_ADMIN_IMAGE'] = inits['bootstrap']['image']
    pol = next(c for c in ppod['containers'] if c['name'] == 'polaris')
    write(os.path.join(out, 'env', 'polaris.env'), env_file(pol, sec))
    env['LH_POLARIS_IMAGE'] = pol['image']

    # The catalog-registration Job.
    jpod = find(docs, 'Job', 'polaris-catalog-init')['spec']['template']['spec']
    ci = next(c for c in jpod['containers'] if c['name'] == 'catalog-init')
    write(os.path.join(out, 'env', 'catalog-init.env'), env_file(ci, sec))
    write(os.path.join(out, 'sh', 'catalog-init.sh'), script(ci))
    env['LH_CURL_IMAGE'] = ci['image']

    # Object store: the chart's bundled MinIO (its STS is what Polaris 1.1 vends credentials
    # through) and the chart's bucket-init Job.
    mpod = find(docs, 'Deployment', 'minio')['spec']['template']['spec']
    minio = next(c for c in mpod['containers'] if c['name'] == 'minio')
    write(os.path.join(out, 'env', 'minio.env'), env_file(minio, sec))
    if any(' ' in a for a in minio['args']):
        raise SystemExit('render.py: a MinIO arg contains a space')
    env['LH_MINIO_IMAGE'] = minio['image']
    env['LH_MINIO_ARGS'] = ' '.join(minio['args'])
    bpod = find(docs, 'Job', 'seaweedfs-bucket-init')['spec']['template']['spec']
    bi = next(c for c in bpod['containers'] if c['name'] == 'bucket-init')
    write(os.path.join(out, 'env', 'bucket-init.env'), env_file(bi, sec))
    write(os.path.join(out, 'sh', 'bucket-init.sh'), script(bi))
    env['LH_AWSCLI_IMAGE'] = bi['image']

    # data-runner (WP-37): its env as the chart renders it (Polaris client, object store), so the
    # tag/branch commits in versions.int.test go through the real PyIceberg -> Polaris hop. The
    # image is built from images/extensions/data-runner (compose.yaml), i.e. the code under test.
    if 'service-bearer-token' not in sec:
        sec['service-bearer-token'] = {'SERVICE_BEARER_TOKEN': os.environ.get('LH_BEARER', '')}
    dpod = find(docs, 'Deployment', 'data-runner')['spec']['template']['spec']
    dr = next(c for c in dpod['containers'] if c['name'] == 'data-runner')
    write(os.path.join(out, 'env', 'data-runner.env'), env_file(dr, sec))

    write(os.path.join(out, 'compose.env'), ''.join(f'{k}={v}\n' for k, v in sorted(env.items())))
    write(os.path.join(out, 'pins.json'), json.dumps(env, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2:])
