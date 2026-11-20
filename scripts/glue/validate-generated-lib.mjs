#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling (GLUE-6)
 * FEATURE:    File plumbing for scripts/validate-generated.sh — read the chart's pinned images,
 *             write golden dbt fixtures out as real project directories in the checkout layout
 *             the Dagster code location reads, and pull the rendered OPA policy files out of
 *             `helm template`.
 * USER STORY: As a maintainer I want the generated-config validators to run on exactly what
 *             production loads (the chart's images, the rendered ConfigMap), so a pass means the
 *             component's own tool accepted it — not that our copy of the rules did.
 * ARCHITECTURE:
 *   - No validation logic lives here: it only moves bytes. The tools (dbt, dagster, opa,
 *     kubeconform) decide, in containers, in validate-generated.sh.
 *   - Versions are READ from charts/sovereign-agentic-os/values.yaml and scripts/glue/
 *     validators.json; nothing is pinned in this file.
 *   - `knownRefusals` in validators.json is the ratchet: fixtures a validator refuses today.
 *   - Subcommands: `images`, `materialise <outDir> <fixture.json>…`, `opa-extract <outDir>`
 *     (rendered chart on stdin). js-yaml comes from os-ui/node_modules (already a dependency).
 */
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml');
const [cmd, ...args] = process.argv.slice(2);
const die = (msg) => { console.error(`validate-generated-lib: ${msg}`); process.exit(2); };
// The dbt project directory of a design-12 repo: repo-layout.ts's DEFAULT_DBT_PROJECT_DIR, overridable
// by OS_DBT_PROJECT_DIR exactly as os-ui and os_projects.py read it. Resolved from the module's text.
const LAYOUT_TS = readFileSync(join(repo, 'os-ui/core/infra/repo-layout.ts'), 'utf8');
const DATA_DIR_TS = (LAYOUT_TS.match(/export const DATA_DIR = '([^']+)'/) ?? [])[1];
const DBT_SUB_TS = (LAYOUT_TS.match(/export const DEFAULT_DBT_PROJECT_DIR = `\$\{DATA_DIR\}\/([^`]+)`/) ?? [])[1];
if (!DATA_DIR_TS || !DBT_SUB_TS) die('os-ui/core/infra/repo-layout.ts: DATA_DIR / DEFAULT_DBT_PROJECT_DIR not found');
const DBT_PROJECT_DIR = (process.env.OS_DBT_PROJECT_DIR ?? '').replace(/^\/+|\/+$/g, '') || `${DATA_DIR_TS}/${DBT_SUB_TS}`;

if (cmd === 'images') {
  const v = yaml.load(readFileSync(join(repo, 'charts/sovereign-agentic-os/values.yaml'), 'utf8'));
  const dep = (v?.dagster?.['dagster-user-deployments']?.deployments ?? []).find((d) => d.name === 'sovereign');
  if (!dep?.image?.repository || !dep?.image?.tag) die('values.yaml has no dagster user deployment `sovereign` with image.repository/tag');
  const opa = v?.opa?.image;
  if (!opa?.repository || !opa?.tag || !opa?.digest) die('values.yaml opa.image needs repository, tag and digest');
  const val = JSON.parse(readFileSync(join(repo, 'scripts/glue/validators.json'), 'utf8'));
  const kc = val?.kubeconform;
  if (!kc?.image || !kc?.kubernetesVersion) die('scripts/glue/validators.json needs kubeconform.image and kubeconform.kubernetesVersion');
  // Shell-sourceable assignments (values are image references: no quotes or spaces in them).
  console.log(`DAGSTER_IMAGE=${dep.image.repository}:${dep.image.tag}`);
  console.log(`OPA_IMAGE=${opa.repository}:${opa.tag}@${opa.digest}`);
  console.log(`KUBECONFORM_IMAGE=${kc.image}`);
  const trino = v?.trino?.image;
  if (!trino?.repository || !trino?.tag) die('values.yaml trino.image needs repository and tag');
  console.log(`TRINO_IMAGE=${trino.repository}:${trino.tag}${trino.digest ? `@${trino.digest}` : ''}`);
  console.log(`KUBERNETES_VERSION=${kc.kubernetesVersion}`);
  console.log(`DBT_PROJECT_DIR=${DBT_PROJECT_DIR}`);
  // Space-separated fixture names whose dbt parse is a KNOWN refusal (the GLUE-6 ratchet).
  const known = Object.keys(val?.knownRefusals?.["dbt-parse"] ?? {}).filter((k) => !k.startsWith("$"));
  if (known.some((k) => !/^[A-Za-z0-9._-]+$/.test(k))) die("knownRefusals names must be plain fixture names");
  console.log(`KNOWN_DBT_REFUSALS="${known.join(" ")}"`);
} else if (cmd === 'known-match') {
  // The text a KNOWN dbt refusal must still contain (validators.json knownRefusals.dbt-parse.<name>.match).
  const val = JSON.parse(readFileSync(join(repo, 'scripts/glue/validators.json'), 'utf8'));
  const m = val?.knownRefusals?.['dbt-parse']?.[args[0]]?.match;
  if (!m) die(`knownRefusals.dbt-parse.${args[0]} has no \`match\` text`);
  process.stdout.write(m);
} else if (cmd === 'materialise') {
  // <outDir>/<domain>/<sha>/… + <outDir>/<domain>/current -> <sha>: the layout repo-sync.sh
  // leaves and os_projects.discover() reads. The domain is the fixture's file name; the "sha" is
  // a content hash (any 40-hex name is what discover() accepts — no git is involved).
  const [out, ...fixtures] = args;
  if (!out || !fixtures.length) die('usage: materialise <outDir> <fixture.json>…');
  for (const f of fixtures) {
    const domain = basename(f).replace(/\.golden\.json$|\.json$/, '');
    const text = readFileSync(f, 'utf8');
    const files = JSON.parse(text);
    if (!files || typeof files !== 'object' || !files['dbt_project.yml']) die(`${f}: not a path→content map with a dbt_project.yml`);
    const sha = createHash('sha1').update(text).digest('hex');
    const root = join(out, domain, sha);
    for (const [p, content] of Object.entries(files)) {
      // The design-12 repo layout (WP-49/WP-55): the dbt project under `data/dbt/`, the Dagster code
      // location under `data/dagster/`, the OS layer under `os/`. Goldens are written with the dbt
      // project at their root, so every other path moves under DBT_PROJECT_DIR here.
      const target = join(root, p.startsWith('os/') || p.startsWith('data/') ? p : `${DBT_PROJECT_DIR}/${p}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(content));
    }
    const link = join(out, domain, 'current');
    if (!existsSync(link)) symlinkSync(sha, link);
    console.log(`${domain} ${sha}`);
  }
} else if (cmd === 'opa-extract') {
  const [out] = args;
  if (!out) die('usage: opa-extract <outDir> < rendered.yaml');
  const docs = yaml.loadAll(readFileSync(0, 'utf8')).filter(Boolean);
  const cm = docs.find((d) => d.kind === 'ConfigMap' && d.metadata?.name === 'opa-policy');
  if (!cm?.data) die('the rendered chart has no ConfigMap `opa-policy` (is opa.enabled false?)');
  mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(cm.data)) {
    writeFileSync(join(out, name), content);
    console.log(name);
  }
} else {
  die('usage: images | materialise <outDir> <fixture.json>… | opa-extract <outDir>');
}
