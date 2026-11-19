/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Extract the litellm-agent-key-init Job's shell script from the chart's RENDERED manifests,
// so the test runs exactly what the cluster runs.  node mkjob.mjs <rendered.yaml> <out.sh> <js-yaml dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [, , rendered, out, yamlDir] = process.argv;
const yaml = createRequire(import.meta.url)(yamlDir || 'js-yaml');
const job = yaml.loadAll(readFileSync(rendered, 'utf8')).find((d) => d?.kind === 'Job' && d.metadata?.name === 'litellm-agent-key-init');
if (!job) throw new Error('Job litellm-agent-key-init not rendered');
writeFileSync(out, job.spec.template.spec.containers[0].args[0]);
console.log(`wrote ${out}`);
