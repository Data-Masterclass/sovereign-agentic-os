#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-56: render the chart with the backup features ON and write what the tests run, so the
# integration tests execute EXACTLY the rendered containers (command, env, uid, mounts) rather
# than a hand-written copy of them.
#
#   python3 tests/backup/render.py <out-dir>
#
# Writes <out-dir>/scripts/<key> — the rendered `backup-scripts` ConfigMap, i.e. exactly the
# files mounted at /opt/soa/backup — and <out-dir>/render.json:
#         {"drill": {"uid": 999, "containers": [{name, image, command, env: {k: v | {"secret": …}},
#           mounts: [paths]}]}, "osuiPod": <os-ui pod spec>, "modifier": <strategic patch JSON>}
import json
import subprocess
import sys

import yaml

CHART = 'charts/sovereign-agentic-os'
ON = [
    'backup.gitBundles.enabled=true', 'backup.gitBundles.bucket=soa-bundles',
    'backup.gitBundles.image.digest=sha256:' + '0' * 64,
    'backup.drill.enabled=true', 'backup.pgDump.enabled=true',
    'backup.drill.postgresCompare.criticalTables={shop:public.orders}',
    'backup.veleroDrill.enabled=true', 'backup.veleroDrill.acceptRestoreCreateRisk=true',
]


def main(outdir):
    import os
    os.makedirs(os.path.join(outdir, 'scripts'), exist_ok=True)
    args = ['helm', 'template', 't', CHART, '-n', 'agentic-os']
    for s in ON:
        args += ['--set', s]
    docs = [d for d in yaml.safe_load_all(subprocess.run(args, check=True, capture_output=True, text=True).stdout) if d]
    find = lambda kind, name: next(d for d in docs if d['kind'] == kind and d['metadata']['name'] == name)

    def containers(spec):
        out = []
        for c in spec.get('initContainers', []) + spec['containers']:
            env = {}
            for e in c.get('env', []):
                env[e['name']] = e['value'] if 'value' in e else {'secret': e['valueFrom']}
            out.append({'name': c['name'], 'image': c['image'], 'command': c['command'] + c.get('args', []),
                        'env': env, 'mounts': [m['mountPath'] for m in c.get('volumeMounts', [])]})
        return out

    for k, v in find('ConfigMap', 'backup-scripts')['data'].items():
        with open(os.path.join(outdir, 'scripts', k), 'w') as f:
            f.write(v)
    side = next(c for c in find('Deployment', 'os-ui')['spec']['template']['spec']['containers'] if c['name'] == 'git-backup')
    drill = find('CronJob', 'restore-drill')['spec']['jobTemplate']['spec']['template']['spec']
    pod = find('Deployment', 'os-ui')['spec']['template']['spec']
    mod = yaml.safe_load(find('ConfigMap', 'velero-drill-modifier')['data']['modifier.yaml'])
    patch = json.loads(mod['resourceModifierRules'][0]['strategicPatches'][0]['patchData'])
    json.dump({'drill': {'uid': drill['securityContext']['runAsUser'], 'containers': containers(drill)},
               'sidecar': containers({'containers': [side]})[0],
               'osuiPod': pod, 'modifier': patch}, open(os.path.join(outdir, 'render.json'), 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1])
