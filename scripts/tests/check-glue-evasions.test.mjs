/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The independent verifier's evasion table (WP-01 review, 2026-11-20) as permanent
 *             tests: every rewrite that once slipped past a glue rule must now be CAUGHT by it.
 * USER STORY: As the owner I want the cheap ways around a CI rule — aliasing fetch or setInterval,
 *             `catch { return null }`, a version built with join, an image tag in a string,
 *             `export { handler as POST }`, an OS key hidden in a Vega-Lite spec or a Dagster kwarg —
 *             to stay closed once they have been found.
 * ARCHITECTURE:
 *   - The case table below is copied verbatim from the verifier's harness (evade.mjs): [rule,
 *     label, {path: content}]. Each case is written into a minimal tree (with the repo's
 *     node_modules linked, as in the harness) and the real checker must report the case's rule.
 *   - Control cases ("CONTROL …") are the plain spelling of each violation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = join(REPO, 'scripts', 'check-glue.mjs');
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'glue-ev-'));
  put(root, 'os-ui/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@core/*': ['./core/*'], '@tabs/*': ['./tabs/*'] } } }));
  put(root, 'os-ui/core/adapters/_contract.ts', "export type Fetched<T> = { ok: true; value: T } | { ok: false; reason: string };\n");
  put(root, 'os-ui/core/kernel/offline-mock.ts', "export const refuse = (nodeEnv: string) => nodeEnv === 'production';\n");
  put(root, 'os-ui/core/infra/litellm-admin.ts', "export const k = 1;\n");
  put(root, 'os-ui/tabs/other/lib/x.ts', "export const x = 1;\n");
  put(root, 'scripts/structure-baseline.json', JSON.stringify({ glue: {} }));
  symlinkSync(join(REPO, 'os-ui', 'node_modules'), join(root, 'os-ui', 'node_modules'));
  return root;
}

// ---- copied verbatim from the verifier's evade.mjs ----
const cases = [
  // [rule expected, label, {path: content}]
  ['GLUE-1','CONTROL fetch(', {'os-ui/tabs/z/lib/a.ts': "export const a = (u: string) => fetch(u);\n"}],
  ['GLUE-1','alias: const f = globalThis.fetch; f(u)', {'os-ui/tabs/z/lib/a.ts': "const f = globalThis.fetch;\nexport const a = (u: string) => f(u);\n"}],
  ['GLUE-1','bracket: globalThis["fetch"](u)', {'os-ui/tabs/z/lib/a.ts': "export const a = (u: string) => globalThis['fetch'](u);\n"}],
  ['GLUE-1','node:http request', {'os-ui/tabs/z/lib/a.ts': "import { request } from 'node:http';\nexport const a = (u: string) => request(u);\n"}],
  ['GLUE-1','static import undici (not installed)', {'os-ui/tabs/z/lib/a.ts': "import { request } from 'undici';\nexport const a = request;\n"}],
  ['GLUE-1','new pg.Pool(', {'os-ui/tabs/z/lib/a.ts': "import pg from 'pg';\nexport const p = new pg.Pool();\n"}],
  ['GLUE-1','dyn import concat child_process', {'os-ui/tabs/z/lib/a.ts': "export const a = () => import('node:' + 'child_process');\n"}],
  ['GLUE-1','config["trinoUrl"]', {'os-ui/tabs/z/lib/a.ts': "declare const config: any;\nexport const a = config['trinoUrl'];\n"}],
  ['GLUE-1','destructure { trinoUrl } = config', {'os-ui/tabs/z/lib/a.ts': "declare const config: any;\nconst { trinoUrl } = config;\nexport const a = trinoUrl;\n"}],
  ['GLUE-2','CONTROL names LITELLM_MASTER_KEY', {'os-ui/core/runtime/a.ts': "export const k = process.env.LITELLM_MASTER_KEY;\n"}],
  ['GLUE-2','env key built from parts', {'os-ui/core/runtime/a.ts': "export const k = process.env['LITELLM_' + 'MASTER_KEY'];\n"}],
  ['GLUE-2','CONTROL runtime imports litellm-admin', {'os-ui/core/runtime/a.ts': "import { k } from '@core/infra/litellm-admin';\nexport const a = k;\n"}],
  ['GLUE-2','template-literal dynamic import', {'os-ui/core/runtime/a.ts': "const n = 'admin';\nexport const a = () => import(`@core/infra/litellm-${n}`);\n"}],
  ['GLUE-3','CONTROL catch { return [] }', {'os-ui/core/z/a.ts': "export async function a() { try { return await g(); } catch { return []; } }\ndeclare function g(): Promise<number[]>;\n"}],
  ['GLUE-3','catch { return null }', {'os-ui/core/z/a.ts': "export async function a() { try { return await g(); } catch { return null; } }\ndeclare function g(): Promise<number[]>;\n"}],
  ['GLUE-3','catch { return [] as number[] }', {'os-ui/core/z/a.ts': "export async function a() { try { return await g(); } catch { return [] as number[]; } }\ndeclare function g(): Promise<number[]>;\n"}],
  ['GLUE-3','catch (e) { void e; return [] }', {'os-ui/core/z/a.ts': "export async function a() { try { return await g(); } catch (e) { void e; return []; } }\ndeclare function g(): Promise<number[]>;\n"}],
  ['GLUE-3','.catch(() => null)', {'os-ui/core/z/a.ts': "declare function g(): Promise<number[]>;\nexport const a = () => g().catch(() => null);\n"}],
  ['GLUE-3','.catch(noop) named', {'os-ui/core/z/a.ts': "declare function g(): Promise<number[]>;\nconst noop = () => [];\nexport const a = () => g().catch(noop);\n"}],
  ['GLUE-3','empty catch in app/api route', {'os-ui/app/api/z/route.ts': "export async function GET() { try { await 1; } catch {} return new Response('ok'); }\n"}],
  ['GLUE-4','CONTROL "1.2.3"', {'os-ui/tabs/z/lib/a.ts': "export const v = '1.2.3';\n"}],
  ['GLUE-4','built from parts [1,2,3].join(".")', {'os-ui/tabs/z/lib/a.ts': "export const v = [1, 2, 3].join('.');\n"}],
  ['GLUE-4','template `${1}.${2}.${3}`', {'os-ui/tabs/z/lib/a.ts': "const M = 1;\nexport const v = `${M}.2.3`;\n"}],
  ['GLUE-4','"v" + "1.2" + ".3"', {'os-ui/tabs/z/lib/a.ts': "export const v = 'v1.2' + '.3';\n"}],
  ['GLUE-4','library image "postgres:16.4"', {'os-ui/tabs/z/lib/a.ts': "export const img = 'postgres:16.4';\n"}],
  ['GLUE-4','export { nodes } re-export', {'os-ui/tabs/z/lib/a.ts': "const nodes = [{ name: 'a', status: 'ok' }];\nexport { nodes };\n"}],
  ['GLUE-5','CONTROL FOR UPDATE SKIP LOCKED', {'os-ui/tabs/z/lib/a.ts': "export const q = 'SELECT 1 FOR UPDATE SKIP LOCKED';\n"}],
  ['GLUE-5','SKIP LOCKED split across concat', {'os-ui/tabs/z/lib/a.ts': "export const q = 'SELECT 1 FOR UPDATE ' + 'SKIP LOCKED';\n"}],
  ['GLUE-5','rename cron fn: nextFireTime', {'os-ui/tabs/z/lib/a.ts': "export function nextFireTime(expr: string) { return expr.split(' ').length; }\n"}],
  ['GLUE-5','rename ranker: fuseScores', {'os-ui/tabs/z/lib/a.ts': "export function fuseScores(a: number[], b: number[]) { return a.map((x, i) => 1/(60+x) + 1/(60+b[i])); }\n"}],
  ['GLUE-5','password hash via createHash', {'os-ui/tabs/z/lib/a.ts': "import { createHash } from 'node:crypto';\nexport const h = (pw: string) => createHash('sha256').update(pw).digest('hex');\n"}],
  ['GLUE-5','alias crypto scrypt', {'os-ui/tabs/z/lib/a.ts': "import * as c from 'node:crypto';\nconst kdf = c.scryptSync;\nexport const h = (pw: string) => kdf(pw, 's', 64);\n"}],
  ['GLUE-6','CONTROL unregistered rego emitter', {'os-ui/tabs/z/lib/a.ts': "export function emitPolicy() { return { 'policy.rego': 'package x' }; }\n"}],
  ['GLUE-6','filename built from parts', {'os-ui/tabs/z/lib/a.ts': "const ext = '.rego';\nexport function emitPolicy() { return { ['policy' + ext]: 'package x' }; }\n"}],
  ['GLUE-6','renamed fn makePolicy (no generate/emit/render/build)', {'os-ui/tabs/z/lib/a.ts': "export function makePolicy() { return { 'policy.rego': 'package x' }; }\n"}],
  ['GLUE-7','CONTROL POST no authorize', {'os-ui/app/api/z/route.ts': "export async function POST() { return new Response('ok'); }\n"}],
  ['GLUE-7','export { handler as POST }', {'os-ui/app/api/z/route.ts': "async function handler() { return new Response('ok'); }\nexport { handler as POST };\n"}],
  ['GLUE-7','authorize( only in a string', {'os-ui/app/api/z/route.ts': "import { x } from '@core/governance';\nconst note = 'authorize(';\nexport async function POST() { void x; void note; return new Response('ok'); }\n"}],
  ['GLUE-7','MCP tool name in backticks', {'os-ui/core/mcp/z.ts': "export const tool = { name: `delete_everything`, run: () => 1 };\n"}],
  ['GLUE-8','CONTROL setInterval', {'os-ui/core/z/a.ts': "export const t = setInterval(() => 1, 1000);\n"}],
  ['GLUE-8','alias const tick = setInterval', {'os-ui/core/z/a.ts': "const tick = setInterval;\nexport const t = tick(() => 1, 1000);\n"}],
  ['GLUE-8','var named heartbeatish nearby', {'os-ui/core/z/a.ts': "const heartbeat = 1000;\nexport const t = setInterval(() => 1, heartbeat);\n"}],
  ['GLUE-8','server file under a ui/ dir', {'os-ui/core/z/ui/a.ts': "export const t = setInterval(() => 1, 1000);\n"}],
  ['GLUE-9','CONTROL core imports tab', {'os-ui/core/z/a.ts': "import { x } from '@tabs/other/lib/x';\nexport const a = x;\n"}],
  ['GLUE-9','tab->tab relative import', {'os-ui/tabs/z/lib/a.ts': "import { x } from '../../other/lib/x';\nexport const a = x;\n"}],
  ['GLUE-9','template-literal dynamic import', {'os-ui/core/z/a.ts': "const t = 'other';\nexport const a = () => import(`@tabs/${t}/lib/x`);\n"}],
  ['GLUE-9','require via variable', {'os-ui/core/z/a.ts': "const p = '@tabs/other/lib/x';\nexport const a = () => require(p);\n"}],
];
const g10 = (golden) => ({
  'scripts/glue/generators.d/z.json': JSON.stringify({ generators: [{ module: 'tabs/z/lib/gen.ts', validator: 'x', goldens: ['tabs/z/golden/z.golden.json'] }] }),
  'os-ui/tabs/z/lib/gen.ts': "export const g = 1;\n",
  'os-ui/tabs/z/golden/z.golden.json': JSON.stringify(golden),
});
cases.push(
  ['GLUE-10','CONTROL os_dataset top-level model key', g10({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    os_dataset: d\n'})],
  ['GLUE-10','os: block (no _ or -)', g10({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    os:\n      owner: amir\n'})],
  ['GLUE-10','camelCase osOwner', g10({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    osOwner: amir\n'})],
  ['GLUE-10','unprefixed principal: top-level', g10({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    principal: amir\n'})],
  ['GLUE-10','OS keys under a fake metadata: block', g10({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    metadata:\n      os_owner: amir\n'})],
  ['GLUE-10','SQL Jinja reads meta.os_owner (C3)', g10({'models/m.sql': "select '{{ model.config.meta.os_owner }}' as who\n"})],
  ['GLUE-10','SQL reads os_ via var(), on a config(meta=) line', g10({'models/m.sql': "{{ config(meta={'a':1}) }} select * from t where owner = '{{ var(\"os_principal\") }}'\n"})],
  ['GLUE-10','native code hidden under os/ path', g10({'os/definitions.py': "import os\nprincipal = 'amir'\n"})],
  ['GLUE-10','Vega-Lite os: block (.json not parsed)', g10({'dashboards/x/panel.vl.json': JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', os: { owner: 'a' }, mark: 'bar' })})],
  ['GLUE-10','Python Dagster principal= kwarg', g10({'orchestration/definitions.py': "ScheduleDefinition(name='x', cron_schedule='* * * * *', principal='amir')\n"})],
  ['GLUE-10','.yaml in a non-goldens generator file', g10({'models/schema.yaml': 'version: 2\nmodels:\n  - name: m\n    os_owner: amir\n'})],
);
// WP-53: a generated agent module (agents/<system>/graph.mjs) is LangGraph JS only.
cases.push(
  ['GLUE-10','graph.mjs imports an OS module (11 §4.1 C1 fixture)', g10({'agents/x/graph.mjs': "import { x } from '@core/runtime/agentic';\nexport const TEAM = { name: 'x' };\n"})],
  ['GLUE-10','graph.mjs dynamic-imports an OS module', g10({'agents/x/graph.mjs': "export const load = () => import('@tabs/agents/lib/store');\n"})],
  ['GLUE-10','graph.mjs reads the environment', g10({'agents/x/graph.mjs': "export const key = process.env.LITELLM_MASTER_KEY;\n"})],
  ['GLUE-10','graph.mjs carries an OS key in its team data', g10({'agents/x/graph.mjs': "export const TEAM = { name: 'x', os_owner: 'amir' };\n"})],
);
// ---- end of the copied table ----

for (const [rule, label, files] of cases) {
  test(`${rule} catches: ${label}`, () => {
    const root = tree();
    try {
      for (const [p, t] of Object.entries(files)) put(root, p, t);
      const r = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });
      assert.notEqual(r.status, 2, `checker error: ${r.stderr}`);
      const hit = [...r.stderr.matchAll(/^(GLUE-\d+)-[A-Z0-9-]+: \d+ \(baseline/gm)].map((m) => m[1]);
      assert.ok(hit.includes(rule), `${rule} did not fire (fired: ${hit.join(',') || 'none'})\n${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// ---- second review round (evade2.mjs), copied verbatim. The two GLUE-7 control-flow cases
// (authorize() after the write; authorize() only in dead code) need a control-flow check and are
// scoped in WP-01b; 2 lines omitted for that reason. 'NONE' cases are false-positive
// controls: no rule may fire. ----
const g10b = (golden) => ({
  'scripts/glue/generators.d/z.json': JSON.stringify({ generators: [{ module: 'tabs/z/lib/gen.ts', validator: 'x', goldens: ['tabs/z/golden/z.golden.json'] }] }),
  'os-ui/tabs/z/lib/gen.ts': "export const g = 1;\n",
  'os-ui/tabs/z/golden/z.golden.json': JSON.stringify(golden),
});
const cases2 = [
  ['NONE','FP-CONTROL empty tree', {}],
  ['NONE','FP-CONTROL tab uses adapter; catch returns Fetched ok:false', {'os-ui/core/adapters/demo/read.ts': "import type { Fetched } from '../_contract';\nexport async function info(u: string): Promise<Fetched<unknown>> {\n  try { return { ok: true, value: await (await fetch(u)).json() }; } catch (e) { return { ok: false, reason: String(e) }; }\n}\n", 'os-ui/tabs/demo/lib/use.ts': "import { info } from '@core/adapters/demo/read';\nexport const load = () => info('/x');\n"}],
  ['NONE','FP-CONTROL generated graph.mjs: node:fs + LangGraph + langchain imports, header comment', g10b({'agents/x/graph.mjs': "// GENERATED by os-ui agent-module@1 from agent-system/sys_1. Do not edit; edit the source.\nimport { readFileSync } from 'node:fs';\nimport { StateGraph } from '@langchain/langgraph';\nimport { createAgent } from 'langchain';\nexport const TEAM = { name: 'x', agents: [] };\n", 'agents/x/run.mjs': "import { ChatOpenAI } from '@langchain/openai';\nconst baseURL = process.env.OPENAI_BASE_URL;\nexport { ChatOpenAI, baseURL };\n"})],
  ['NONE','FP-CONTROL dbt meta + header comment', g10b({'models/schema.yml': 'version: 2\nmodels:\n  - name: m\n    config:\n      meta:\n        os_owner: amir\n', 'models/m.sql': "-- m — gold layer of OS dataset ds_1 (generated by Sovereign OS)\nselect 1 as x\n"})],
  ['GLUE-1','NEW computed member name g["fe"+"tch"]', {'os-ui/tabs/z/lib/a.ts': "const g = globalThis as any;\nconst n = 'fe' + 'tch';\nexport const a = (u: string) => g[n](u);\n"}],
  ['GLUE-2','NEW scan env for *MASTER_KEY', {'os-ui/core/runtime/a.ts': "export const k = Object.entries(process.env).find(([n]) => n.endsWith('MASTER_KEY'))?.[1];\n"}],
  ['GLUE-3','NEW .then(ok, () => [])', {'os-ui/core/z/a.ts': "declare function g(): Promise<number[]>;\nexport const a = () => g().then((r) => r, () => []);\n"}],
  ['GLUE-3','NEW catch returns fallback() helper', {'os-ui/core/z/a.ts': "declare function g(): Promise<number[]>;\nconst empty = (): number[] => [];\nexport async function a() { try { return await g(); } catch { return empty(); } }\n"}],
  ['GLUE-4','NEW MAJOR + "." + MINOR + ".0"', {'os-ui/tabs/z/lib/a.ts': "const MAJOR = 1, MINOR = 2;\nexport const v = MAJOR + '.' + MINOR + '.0';\n"}],
  ['GLUE-5','NEW in-memory queue lib p-queue', {'os-ui/tabs/z/lib/a.ts': "import PQueue from 'p-queue';\nexport const q = new PQueue({ concurrency: 1 });\n"}],
  ['GLUE-8','NEW setTimeout self-rescheduling loop', {'os-ui/core/z/a.ts': "function loop() { void 0; setTimeout(loop, 1000); }\nexport const start = () => loop();\n"}],
  ['GLUE-9','NEW createRequire(import.meta.url)(path)', {'os-ui/core/z/a.ts': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const a = () => r('../../tabs/other/lib/x');\n"}],
  ['GLUE-10','NEW dbt_project +os_owner project config', g10b({'dbt_project.yml': "name: sales\nversion: 1.0.0\nconfig-version: 2\nprofile: sovereign\nmodels:\n  sales:\n    +os_owner: amir\n"})],
  ['GLUE-10','NEW SQL config(alias=var("os_scope"))', g10b({'models/m.sql': "{{ config(alias=var('os_scope')) }}\nselect 1 as x\n"})],
  ['GLUE-10','NEW k8s label without sovereign-os.io/ prefix', g10b({'apps/x/deploy/kustomization.yaml': "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\ncommonLabels:\n  os_owner: amir\n"})],
];
for (const [rule, label, files] of cases2) {
  test(`round 2: ${rule === 'NONE' ? 'no rule fires on' : rule + ' catches'}: ${label}`, () => {
    const root = tree();
    try {
      for (const [p, t] of Object.entries(files)) put(root, p, t);
      const r = spawnSync(process.execPath, [CHECK, '--root', root], { encoding: 'utf8' });
      assert.notEqual(r.status, 2, `checker error: ${r.stderr}`);
      const hit = [...r.stderr.matchAll(/^(GLUE-\d+)-[A-Z0-9-]+: \d+ \(baseline/gm)].map((m) => m[1]);
      if (rule === 'NONE') assert.deepEqual(hit, [], `false positive: ${hit.join(',')}\n${r.stderr}`);
      else assert.ok(hit.includes(rule), `${rule} did not fire (fired: ${hit.join(',') || 'none'})\n${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
