#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Deploy preflight — every model the gateway references exists as a LiteLLM DATABASE row.
 * USER STORY: As the owner I never lose a model to a deploy. Models are created by hand in each environment's
 *             LiteLLM (database managed) and the chart writes NO config models any more, so a deploy must not
 *             go ahead while a role alias, a virtual key or a still-live config model names a model that has
 *             no database row — that model would vanish with the deploy.
 * USAGE:      node scripts/gateway/preflight-db-models.mjs --env dev|prod [--context <ctx>] [--kubeconfig <file>]
 *             Run by scripts/deploy.sh before the backup and `helm upgrade`. Exit 0 = nothing missing;
 *             1 = missing (listed, with what references each); 3 = the gateway could not be read.
 * ARCHITECTURE: scripts/gateway/gateway_live.py `preflight` inside the gateway pod (the master key stays there;
 *             only model names, alias names and key ALIASES are printed — never a key).
 */
import { args, guard, inPod, target } from './lib.mjs';

const a = args(process.argv.slice(2));
if (a.env !== 'dev' && a.env !== 'prod') {
  console.error('usage: node scripts/gateway/preflight-db-models.mjs --env dev|prod [--context <ctx>] [--kubeconfig <file>]');
  process.exit(2);
}
const t = target(a.env, { context: a.context, kubeconfig: a.kubeconfig });
let pf;
try {
  guard(t);
  pf = inPod(t, ['preflight', '--ignore', process.env.GATEWAY_ACCESS_GROUP || 'os-admin-registered']);
} catch (e) {
  console.error(`GATEWAY_PREFLIGHT_UNREADABLE — ${e.message}`);
  process.exit(3);
}
console.log(`   ${pf.db_models.length} database model(s), ${pf.config_models.length} config model(s) (dropped by this deploy), ${pf.aliases} alias(es)`);
if (!pf.missing.length) {
  console.log('   every model a role alias, a virtual key or the config file names has a database row');
  process.exit(0);
}
console.error('GATEWAY_MODELS_MISSING — these models are referenced but have NO LiteLLM database row; this deploy drops the config-file models, so they would stop answering:');
for (const m of pf.missing) console.error(`     ${m.name}  (referenced by: ${m.referenced_by.join('; ')})`);
console.error(`   Fix: node scripts/gateway/migrate-config-models-to-db.mjs --env ${t.env} --apply (config models), or create the model in ${t.env}'s LiteLLM UI, or repoint the alias / key. docs/components/litellm.md "Models live in LiteLLM's database".`);
process.exit(1);
