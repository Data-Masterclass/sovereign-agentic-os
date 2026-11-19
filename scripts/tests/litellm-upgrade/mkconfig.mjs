/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Derive a local LiteLLM config from the chart's RENDERED ConfigMap. The config TEXT is kept
// byte-for-byte as Helm rendered it (number formatting included — `8e-08` is not the same thing
// to a YAML 1.1 parser as `8.0e-08`); only the upstream endpoint and the MCP URL are pointed at
// the local stub, and optional sed-style replacements are applied.
//   node mkconfig.mjs <rendered-manifests.yaml> <out-config.yaml> <js-yaml dir> [from=>to ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [, , rendered, out, yamlDir, ...subs] = process.argv;
const yaml = createRequire(import.meta.url)(yamlDir || 'js-yaml');
const docs = yaml.loadAll(readFileSync(rendered, 'utf8'));
const cm = docs.find((d) => d?.kind === 'ConfigMap' && /litellm-config$/.test(d.metadata?.name ?? ''));
if (!cm) throw new Error('no *-litellm-config ConfigMap in the rendered manifests');
let text = cm.data['config.yaml'];
text = text.replace(/^(\s*api_base:\s*).*$/gm, '$1http://stub:8080/v1');
text = text.replace(/^(\s*url:\s*)http:\/\/query-tool:8000\/mcp\s*$/gm, '$1http://stub:8080/mcp');
for (const s of subs) { const [a, b] = s.split('=>'); text = text.split(a).join(b); }
writeFileSync(out, text);
const cfg = yaml.load(text);
console.log(`wrote ${out}: ${cfg.model_list.length} models, callbacks=${JSON.stringify(cfg.litellm_settings?.success_callback)}, redaction=${cfg.litellm_settings?.turn_off_message_logging ?? 'unset'}`);
