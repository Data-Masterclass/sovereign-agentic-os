/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read an image pin from the chart's own values (no version literal in the harness)
 * USER STORY: As AT-e/AT-f I want the native tools to run in exactly the image the chart pins, so
 *             an eject test can never pass on a newer or older tool than production runs.
 * ARCHITECTURE:
 *   - Merges values.yaml ← values.local.yaml ← tests/e2e/kind/values.e2e.yaml (the install order)
 *     with python3 + PyYAML (the same dependency scripts/os already has) and prints one dotted path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HopError } from './hop.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PY = `
import sys, json, yaml
def merge(a, b):
    for k, v in (b or {}).items():
        a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a
v = {}
for f in ['charts/sovereign-agentic-os/values.yaml', 'values.local.yaml', 'tests/e2e/kind/values.e2e.yaml']:
    v = merge(v, yaml.safe_load(open(f)))
for p in sys.argv[1].split('.'):
    v = v[p]
print(json.dumps(v))
`;

export async function chartValue(path) {
  try {
    const { stdout } = await exec('python3', ['-c', PY, path], { cwd: ROOT });
    return JSON.parse(stdout);
  } catch (err) {
    throw new HopError({ component: 'chart', hop: `values ${path}`, reason: (err.stderr || err.message).trim().split('\n').at(-1) });
  }
}

/** "<repository>:<tag>[@<digest>]" for an image block at `path` (e.g. "opa.image"). */
export async function chartImage(path) {
  const img = await chartValue(path);
  const ref = `${img.repository}:${img.tag}`;
  return img.digest && !String(img.tag).includes('@') ? `${ref}@${img.digest}` : ref;
}
