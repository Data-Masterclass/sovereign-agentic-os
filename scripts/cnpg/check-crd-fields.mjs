#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE: App Builder app databases (workstream D) - refuse a CloudNativePG release whose CRDs the os-ui admission
 *   policy does not fully know.
 * USER STORY: As the owner I want an operator upgrade that adds a Cluster or Database field to stop the install until the
 *   policy that keeps os-ui away from that field is updated, instead of leaving the new field unchecked.
 * ARCHITECTURE: reads the release manifest as JSON (`kubectl create --dry-run=client -o json`, so no YAML parser is needed)
 *   and compares the .spec properties of the Cluster and Database CRDs (every served version) with
 *   charts/sovereign-agentic-os/files/cnpg/{cluster,database}-spec-fields.txt. Exit 1 names every unknown property.
 *   Usage: node scripts/cnpg/check-crd-fields.mjs <manifest.json> <fields-dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [manifest, dir] = process.argv.slice(2);
/** kubectl prints one JSON document per object, back to back: split them at depth 0 (strings respected). */
function documents(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}
const items = documents(readFileSync(manifest, 'utf8')).flatMap((d) => (d.kind === 'List' ? d.items : [d]));
const known = (f) => new Set(readFileSync(join(dir, `${f}-spec-fields.txt`), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const missing = [];
for (const [kind, file] of [['Cluster', 'cluster'], ['Database', 'database']]) {
  const crd = items.find((i) => i.kind === 'CustomResourceDefinition' && i.spec?.group === 'postgresql.cnpg.io' && i.spec?.names?.kind === kind);
  if (!crd) { missing.push(`${kind}: CRD not in the manifest`); continue; }
  const k = known(file);
  for (const v of crd.spec.versions) {
    for (const p of Object.keys(v.schema?.openAPIV3Schema?.properties?.spec?.properties ?? {})) if (!k.has(p)) missing.push(`${kind}(${v.name}).spec.${p}`);
  }
}
if (missing.length) {
  console.error(`refusing: the CNPG CRDs have .spec properties the os-ui admission policy does not know: ${missing.join(', ')} (add them to charts/sovereign-agentic-os/files/cnpg/ and review the policy)`);
  process.exit(1);
}
console.log('cnpg CRD fields: every Cluster/Database .spec property is known to the os-ui admission policy');
