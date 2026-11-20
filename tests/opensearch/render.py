#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Render the chart the way the STACKIT deploy does and write out what the real containers need.

    python3 tests/opensearch/render.py <out-dir>

`helm template` with the STACKIT overlay (deploy/overlays/opensearch-s3-snapshots.stackit.yaml)
plus tests/opensearch/ci-values.yaml (local image, bucket name, fast SM schedule); in the rendered
opensearch.yml only `protocol: https` becomes `http` (SeaweedFS in CI). Writes:
  opensearch.yml          the subchart ConfigMap (s3 client, proxy)
  proxy/tinyproxy.conf    the egress-proxy ConfigMap
  proxy/filter            its allowlist WITH the S3 host (s3 on)
  proxy-noroute/filter    the allowlist the chart renders WITHOUT the S3 feature (negative twin)
  soa/*                   the opensearch-maintenance ConfigMap (client lib, scripts, JSON bodies)
  env/<job>.env           the env of the register / cleanup Jobs (OS_* only; the URL is the harness's)
"""
import os
import subprocess
import sys

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHART = os.path.join(ROOT, 'charts', 'sovereign-agentic-os')
OVERLAY = os.path.join(ROOT, 'deploy', 'overlays', 'opensearch-s3-snapshots.stackit.yaml')
CI = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ci-values.yaml')


def render(*extra):
    out = subprocess.run(
        ['helm', 'template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', *extra],
        check=True, capture_output=True, text=True).stdout
    return [d for d in yaml.safe_load_all(out) if d]


def find(docs, kind, name):
    for d in docs:
        if d.get('kind') == kind and d.get('metadata', {}).get('name') == name:
            return d
    raise SystemExit(f'render.py: {kind}/{name} not rendered')


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)


def main(out):
    docs = render('-f', OVERLAY, '-f', CI)
    osyml = find(docs, 'ConfigMap', 'opensearch-master-config')['data']['opensearch.yml']
    https = 's3.client.default.protocol: https'
    if osyml.count(https) != 1:
        raise SystemExit('render.py: the overlay opensearch.yml must set s3.client.default.protocol: https exactly once')
    write(os.path.join(out, 'opensearch.yml'), osyml.replace(https, 's3.client.default.protocol: http'))
    proxy = find(docs, 'ConfigMap', 'egress-proxy-config')['data']
    # The container runs as `nobody` with the PID file in /tmp; nothing else differs.
    write(os.path.join(out, 'proxy', 'tinyproxy.conf'), proxy['tinyproxy.conf'])
    write(os.path.join(out, 'proxy', 'filter'), proxy['filter'])
    noroute = render('-f', OVERLAY, '-f', CI, '--set', 'opensearchSnapshots.s3.enabled=false')
    write(os.path.join(out, 'proxy-noroute', 'tinyproxy.conf'), proxy['tinyproxy.conf'])
    write(os.path.join(out, 'proxy-noroute', 'filter'), find(noroute, 'ConfigMap', 'egress-proxy-config')['data']['filter'])
    for k, v in find(docs, 'ConfigMap', 'opensearch-maintenance')['data'].items():
        write(os.path.join(out, 'soa', k), v)
    for job in ('register-opensearch-s3-repo', 'opensearch-orphan-cleanup'):
        env = find(docs, 'Job', job)['spec']['template']['spec']['containers'][0]['env']
        lines = [f"{e['name']}={e['value']}" for e in env if e['name'].startswith('OS_') and 'value' in e]
        write(os.path.join(out, 'env', f'{job}.env'), '\n'.join(lines) + '\n')
    sts = find(docs, 'StatefulSet', 'opensearch-master')
    envs = sts['spec']['template']['spec']['containers'][0].get('env', [])
    write(os.path.join(out, 'env', 'opensearch.env'),
          '\n'.join(f"{e['name']}={e['value']}" for e in envs if e['name'] in ('AWS_EC2_METADATA_DISABLED', 'DISABLE_SECURITY_PLUGIN', 'DISABLE_INSTALL_DEMO_CONFIG')) + '\n')
    print(f'render.py: wrote {out}')


if __name__ == '__main__':
    main(sys.argv[1])
