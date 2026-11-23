#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Move one environment's config-file gateway models into LiteLLM's database, without an outage.
 * USER STORY: As the owner I create and change every model by hand in each environment's LiteLLM (database
 *             managed). The models the chart used to put in the config file must exist as database rows,
 *             with the same names and parameters, BEFORE the deploy that stops writing the config list.
 * USAGE:
 *   node scripts/gateway/migrate-config-models-to-db.mjs --env dev|prod [--context <ctx>] [--kubeconfig <file>] [--apply]
 *   Without --apply it only prints the plan. Run it on dev first, then on production.
 * ARCHITECTURE:
 *   1. reads the LIVE config models from the ConfigMap `<rel>-litellm-config` (env references such as
 *      `os.environ/STACKIT_API_KEY`, never a key value);
 *   2. hands them to scripts/gateway/gateway_live.py `migrate` INSIDE the gateway pod, which creates a database
 *      row (`POST /model/new`) for each name that has none — same litellm_params (the `os.environ/` references
 *      included: measured on LiteLLM 1.109.1, a database row keeps the reference and resolves it from the
 *      container's environment, so no key is copied or printed), same model_info, prices also in
 *      litellm_params (1.109.1 keeps a database row's price there);
 *   3. IDEMPOTENT: a name that already has a database row is reported `present` (with any difference in model /
 *      api_base) and never touched; a config model with a LITERAL api_key is `needs_key_in_ui` — create it in
 *      the LiteLLM UI and type the key there;
 *   4. prints the preflight afterwards: what is still referenced (role aliases, virtual keys, config models)
 *      without a database row. The deploy refuses while that list is not empty (scripts/deploy.sh).
 *   During the overlap each migrated name has two identical deployments (config + database); LiteLLM
 *   load-balances across them (measured), so calls keep working. The next deploy drops the config copy.
 *   Never prints a secret. Exit 0 = nothing missing after the run; 1 = something still missing or refused.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT, args, configModels, guard, inPod, target } from './lib.mjs';

const require = createRequire(resolve(ROOT, 'os-ui/package.json'));
const yaml = require('js-yaml');
const a = args(process.argv.slice(2));
if (a.env !== 'dev' && a.env !== 'prod') {
  console.error('usage: node scripts/gateway/migrate-config-models-to-db.mjs --env dev|prod [--context <ctx>] [--kubeconfig <file>] [--apply]');
  process.exit(2);
}
const t = target(a.env, { context: a.context, kubeconfig: a.kubeconfig });
try {
  guard(t);
  const entries = configModels(t, yaml);
  console.log(`${t.env} (${t.context}): ${entries.length} config model(s) in ${t.release}-litellm-config`);
  const payload = Buffer.from(JSON.stringify(entries)).toString('base64');
  const r = inPod(t, ['migrate', payload, ...(a.apply ? ['--apply'] : [])]);
  for (const m of r.models) {
    const extra = m.action === 'present' && m.differs?.length ? ` — the database row differs in ${m.differs.join(', ')}: check it in the LiteLLM UI` : m.reason ? ` — ${m.reason}` : '';
    console.log(`  ${m.action.padEnd(15)} ${m.name}${extra}`);
  }
  if (!a.apply) console.log('  (plan only — run again with --apply to create the rows)');
  const pf = inPod(t, ['preflight', '--ignore', process.env.GATEWAY_ACCESS_GROUP || 'os-admin-registered']);
  // Config models themselves are expected here until the deploy drops them; what matters is a missing DATABASE row.
  const missing = pf.missing;
  if (!missing.length) {
    console.log(`MIGRATE_OK ${t.env}: every referenced model has a database row (${pf.db_models.length} database models). The deploy may now drop the config list.`);
    process.exit(0);
  }
  console.log(`MIGRATE_INCOMPLETE ${t.env}: referenced without a database row:`);
  for (const m of missing) console.log(`  ${m.name}  (${m.referenced_by.join('; ')})`);
  process.exit(1);
} catch (e) {
  console.error(`MIGRATE_FAILED: ${e.message}`);
  process.exit(1);
}
