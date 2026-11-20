/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Pull what the provider test runs FROM THE RENDERED CHART, so the test runs what the cluster runs:
//   gateway image, litellm-egress-env (proxy env), the egress proxy's tinyproxy.conf + filter, the
//   shared agent key's model list (with the access group), and os-ui's LLM_EGRESS_ALLOWLIST /
//   LLM_ACCESS_GROUP.   usage: node render.mjs <rendered.yaml> <outdir> <js-yaml dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const [, , rendered, out, yamlDir] = process.argv;
const yaml = createRequire(import.meta.url)(yamlDir);
const docs = yaml.loadAll(readFileSync(rendered, 'utf8')).filter((d) => d && d.kind);
const find = (kind, pred) => docs.find((d) => d.kind === kind && pred(d.metadata.name)) ?? (() => { throw new Error(`no ${kind}`); })();
mkdirSync(`${out}/proxy`, { recursive: true });
const gw = find('Deployment', (n) => /-litellm$/.test(n)).spec.template.spec.containers[0];
const envCm = find('ConfigMap', (n) => n === 'litellm-egress-env').data ?? {};
if (!(gw.envFrom ?? []).some((e) => e.configMapRef?.name === 'litellm-egress-env')) throw new Error('the gateway does not read litellm-egress-env');
writeFileSync(`${out}/gw.env`, Object.entries(envCm).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
const proxy = find('ConfigMap', (n) => n === 'egress-proxy-config').data;
writeFileSync(`${out}/proxy/tinyproxy.conf`, proxy['tinyproxy.conf']);
writeFileSync(`${out}/proxy/filter`, proxy.filter);
const job = JSON.stringify(docs.filter((d) => d.kind === 'Job' && /agent-key/.test(d.metadata.name)));
const m = job.match(/MODELS='(\[[^']*\])'/);
if (!m) throw new Error('agent key models not found in the key-init Job');
const osui = find('Deployment', (n) => n === 'os-ui').spec.template.spec.containers.find((c) => c.name === 'os-ui');
const envOf = (k) => (osui.env ?? []).find((e) => e.name === k)?.value ?? '';
writeFileSync(`${out}/facts.json`, JSON.stringify({
  image: gw.image, agentKeyModels: JSON.parse(m[1].replace(/\\"/g, '"')),
  allowlist: envOf('LLM_EGRESS_ALLOWLIST'), localModels: envOf('LLM_LOCAL_MODELS'), accessGroup: envOf('LLM_ACCESS_GROUP'),
}, null, 1));
console.log(readFileSync(`${out}/facts.json`, 'utf8'));
