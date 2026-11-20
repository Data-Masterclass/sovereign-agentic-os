/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Derive the gateway's config and env from the chart's RENDERED manifests, so the test runs what
// the cluster runs (adapted from the LiteLLM upgrade test of PR #104).
//   node mkconfig.mjs <rendered.yaml> <out-config.yaml> <out-env> <js-yaml dir> [--legacy-twin]
// - config: the `*-litellm-config` ConfigMap text as Helm rendered it; only provider endpoints and
//   the MCP URL are pointed at the local stub.
// - env: every literal `value` env var of the proxy container (LITELLM_OTEL_V2, the span scope, …)
//   as NAME=VALUE lines. Secret-backed vars are supplied by run.sh with test literals.
// - --legacy-twin: the NEGATIVE TWIN. Adds `success_callback: ["langfuse"]` next to the chart's
//   callbacks — the misconfiguration the e2e test must catch (two generations per call).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [, , rendered, outCfg, outEnv, yamlDir, flag] = process.argv;
const yaml = createRequire(import.meta.url)(yamlDir || 'js-yaml');
const docs = yaml.loadAll(readFileSync(rendered, 'utf8')).filter(Boolean);
const cm = docs.find((d) => d.kind === 'ConfigMap' && /litellm-config$/.test(d.metadata?.name ?? ''));
if (!cm) throw new Error('no *-litellm-config ConfigMap in the rendered manifests');
let text = cm.data['config.yaml'];
text = text.replace(/^(\s*api_base:\s*).*$/gm, '$1http://stub:8080/v1');
text = text.replace(/^(\s*url:\s*)http:\/\/query-tool:8000\/mcp\s*$/gm, '$1http://stub:8080/mcp');
if (flag === '--legacy-twin') {
  if (!/^litellm_settings:\s*$/m.test(text)) throw new Error('rendered config has no top-level litellm_settings');
  const already = [].concat(yaml.load(text).litellm_settings?.success_callback ?? []);
  if (already.length) throw new Error(`rendered config already has success_callback ${JSON.stringify(already)}: nothing to add for the twin`);
  text = text.replace(/^litellm_settings:\s*$/m, 'litellm_settings:\n  success_callback: ["langfuse"]');
}
writeFileSync(outCfg, text);
const dep = docs.find((d) => d.kind === 'Deployment' && /-litellm$/.test(d.metadata?.name ?? ''));
if (!dep) throw new Error('no *-litellm Deployment in the rendered manifests');
const c = dep.spec.template.spec.containers[0];
const keep = (c.env ?? []).filter((e) => 'value' in e && /^(LITELLM_|OTEL_|LANGFUSE_)/.test(e.name));
writeFileSync(outEnv, keep.map((e) => `${e.name}=${e.value}`).join('\n') + '\n');
const cfg = yaml.load(text);
console.log(`config: ${cfg.model_list.length} models, callbacks=${JSON.stringify(cfg.litellm_settings?.callbacks)} success_callback=${JSON.stringify(cfg.litellm_settings?.success_callback)}; env: ${keep.map((e) => `${e.name}=${e.value}`).join(' ')}; image ${c.image}`);
