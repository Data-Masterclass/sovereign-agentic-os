/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the Trino access-control rules generator (engine rebuild B3)
 * USER STORY: As a reviewer I want proof that the dbt service user can become an OS principal and
 *             NOTHING else, that nobody else can impersonate anyone, and that a domain's schema is
 *             ownable only by that domain's principals — provable without a cluster.
 * ARCHITECTURE:
 *   - Pure: literal inputs, a golden file (`fixtures/trino-rules.golden.json`, `REGEN_GOLDEN=1`
 *     rewrites it), and first-match-wins assertions through the module's own evaluator, which is a
 *     transcription of Trino's file-access-control semantics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  buildTrinoRules,
  renderTrinoRules,
  impersonationAllowed,
  schemaOwnerAllowed,
  tablePrivilegesFor,
  anchor,
  literal,
  OWNER_PRIVILEGES,
  type RulesInput,
} from '@core/infra/trino-rules';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'trino-rules.golden.json');

/** The OS id pattern: a domain name or a uid — letters, digits, `_`, `-`, `.`, 1..64 chars. */
const OS_PRINCIPAL_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';

const input: RulesInput = {
  serviceUsers: ['dbt-runner'],
  principalPattern: OS_PRINCIPAL_PATTERN,
  domains: [
    { name: 'sales', schema: 'sales', principals: ['amir', 'bea'] },
    { name: 'finance', schema: 'finance', principals: ['cleo'] },
  ],
  personalLanes: [
    { uid: 'amir', schema: 'personal_amir' },
    { uid: 'bea', schema: 'personal_bea' },
  ],
};

test('golden: rules.json for two domains and two personal lanes', () => {
  const rendered = renderTrinoRules(buildTrinoRules(input));
  if (process.env.REGEN_GOLDEN === '1' || !existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, rendered);
  }
  assert.equal(rendered, readFileSync(GOLDEN, 'utf8'), 'rules.json differs from its golden (REGEN_GOLDEN=1 to accept)');
});

test('the rules file is deterministic and carries no secret', () => {
  const a = renderTrinoRules(buildTrinoRules(input));
  const b = renderTrinoRules(buildTrinoRules({ ...input, domains: [...input.domains].reverse(), serviceUsers: ['dbt-runner', 'dbt-runner'] }));
  assert.equal(a, b, 'input order must not change the file');
  assert.doesNotMatch(a, /password|secret|token|credential/i);
  assert.ok(a.endsWith('}\n') && !a.endsWith('\n\n'));
  assert.deepEqual(JSON.parse(a), buildTrinoRules(input), 'the rendered file parses back to the document');
});

test('the service user may impersonate an OS principal and NOTHING else', () => {
  const rules = buildTrinoRules(input);
  for (const target of ['sales', 'finance', 'amir', 'bea', 'cleo']) {
    assert.equal(impersonationAllowed(rules, 'dbt-runner', target), true, `dbt-runner → ${target}`);
  }
  // Arbitrary strings: not an enumerated OS principal ⇒ refused, then caught by the explicit deny.
  for (const target of [
    'root',
    'trino',
    'dbt-runner',
    'admin; drop',
    'sales trino',
    'sales\nfinance',
    '../sales',
    'sales/finance',
    '',
    'x'.repeat(200),
    '_leading',
    'sales$',
    'sales2',
  ]) {
    assert.equal(impersonationAllowed(rules, 'dbt-runner', target), false, `dbt-runner must NOT become ${JSON.stringify(target)}`);
  }
});

test('nobody but a service user may become another identity; everyone may be themselves', () => {
  const rules = buildTrinoRules(input);
  assert.equal(impersonationAllowed(rules, 'amir', 'bea'), false);
  assert.equal(impersonationAllowed(rules, 'amir', 'sales'), false);
  assert.equal(impersonationAllowed(rules, 'query-agent', 'amir'), false);
  assert.equal(impersonationAllowed(rules, 'trino', 'dbt-runner'), false);
  assert.equal(impersonationAllowed(rules, 'amir', 'amir'), true);
  assert.equal(impersonationAllowed(rules, 'sales', 'sales'), true);
  // A service user with no rule of its own falls through to the self-only rule.
  assert.equal(impersonationAllowed(buildTrinoRules({ ...input, serviceUsers: [] }), 'dbt-runner', 'sales'), false);
});

test('a domain schema is ownable only by that domain and its members', () => {
  const rules = buildTrinoRules(input);
  assert.equal(schemaOwnerAllowed(rules, 'sales', 'sales'), true);
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'sales'), true);
  assert.equal(schemaOwnerAllowed(rules, 'cleo', 'sales'), false, 'a finance member must not own the sales schema');
  assert.equal(schemaOwnerAllowed(rules, 'cleo', 'finance'), true);
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'finance'), false);
  assert.equal(schemaOwnerAllowed(rules, 'dbt-runner', 'sales'), false, 'the service user owns nothing as itself');
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'some_other_schema'), false);
});

test('writes into a domain schema need domain membership; outsiders keep SELECT', () => {
  const rules = buildTrinoRules(input);
  assert.deepEqual(tablePrivilegesFor(rules, 'amir', 'sales', 'gold_order_customer'), [...OWNER_PRIVILEGES]);
  assert.deepEqual(tablePrivilegesFor(rules, 'cleo', 'sales', 'gold_order_customer'), ['SELECT']);
  assert.deepEqual(tablePrivilegesFor(rules, 'sales', 'sales', 'gold_order_customer'), [...OWNER_PRIVILEGES]);
});

test('a personal lane is writable by its owner and readable by nobody else', () => {
  const rules = buildTrinoRules(input);
  assert.deepEqual(tablePrivilegesFor(rules, 'amir', 'personal_amir', 'bronze_orders'), [...OWNER_PRIVILEGES]);
  assert.deepEqual(tablePrivilegesFor(rules, 'bea', 'personal_amir', 'bronze_orders'), []);
  assert.deepEqual(tablePrivilegesFor(rules, 'sales', 'personal_amir', 'bronze_orders'), []);
  assert.deepEqual(tablePrivilegesFor(rules, 'bea', 'personal_bea', 'bronze_orders'), [...OWNER_PRIVILEGES]);
});

test('the chart bootstrap IS this generator with nothing enumerated (one shape, two renderers)', () => {
  const root = join(HERE, '..', '..', '..');
  const values = yaml.load(readFileSync(join(root, 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8')) as {
    trino: { accessControl: { enabled: boolean; serviceUser: string; principalPattern: string; refreshPeriod: string } };
  };
  const ac = values.trino.accessControl;
  assert.equal(ac.principalPattern, OS_PRINCIPAL_PATTERN, 'values.yaml principalPattern must equal OS_PRINCIPAL_PATTERN');
  assert.equal(ac.enabled, true);

  const template = readFileSync(join(root, 'charts', 'sovereign-agentic-os', 'templates', 'extensions', 'lakehouse', 'trino.yaml'), 'utf8');
  const block = /^  rules\.json: \|\n((?:    .*\n|\n)+)/m.exec(template);
  assert.ok(block, 'the chart must render a rules.json block');
  const rendered = block![1]
    .split('\n')
    .map((l) => l.replace(/^ {4}/, ''))
    .join('\n')
    // Expand exactly the two Helm expressions the block uses.
    .replace(/\{\{ \$ac\.serviceUser \| default "[^"]*" \}\}/g, ac.serviceUser)
    .replace(/\{\{ \$ac\.principalPattern \| default "[^"]*" \}\}/g, ac.principalPattern);
  assert.deepEqual(
    JSON.parse(rendered),
    buildTrinoRules({ serviceUsers: [ac.serviceUser], principalPattern: ac.principalPattern, domains: [], personalLanes: [] }),
    'the chart bootstrap and buildTrinoRules({}) must be the same document',
  );
});

test('anchor and literal cannot be widened by the caller', () => {
  assert.equal(anchor('abc'), '^abc$');
  assert.equal(anchor('^abc$'), '^abc$');
  assert.equal(literal('a.b'), '^a\\.b$');
  assert.ok(!new RegExp(literal('sales')).test('sales2'));
  assert.ok(!new RegExp(literal('a.b')).test('axb'));
});

test('the BOOTSTRAP file (nothing enumerated) bounds impersonation but leaves ownership as it was', () => {
  const rules = buildTrinoRules({ serviceUsers: ['dbt-runner'], principalPattern: OS_PRINCIPAL_PATTERN, domains: [], personalLanes: [] });
  assert.equal(impersonationAllowed(rules, 'anyone', 'sales'), false);
  // Ownership stays OPEN until the OS reconciles real membership: closing it on a fresh install
  // would deny every CTAS the OS already performs as the domain principal.
  assert.equal(schemaOwnerAllowed(rules, 'anyone', 'anything'), true);
  assert.deepEqual(tablePrivilegesFor(rules, 'anyone', 'anything'), [...OWNER_PRIVILEGES]);
  // One enumerated lane is enough to close it.
  const closed = buildTrinoRules({ serviceUsers: ['dbt-runner'], principalPattern: OS_PRINCIPAL_PATTERN, domains: [], personalLanes: [{ uid: 'amir', schema: 'personal_amir' }] });
  assert.equal(schemaOwnerAllowed(closed, 'anyone', 'anything'), false);
  assert.deepEqual(tablePrivilegesFor(closed, 'anyone', 'anything'), ['SELECT']);
  // Still usable: with nothing enumerated the service user falls back to the id PATTERN, so a
  // principal can be impersonated before the OS has reconciled the file …
  assert.equal(impersonationAllowed(rules, 'dbt-runner', 'sales'), true);
  // … but a shape that is not an OS id is still refused.
  assert.equal(impersonationAllowed(rules, 'dbt-runner', 'sales; drop'), false);
  assert.equal(impersonationAllowed(rules, 'dbt-runner', ''), false);
});

// --------------------------------------------- B3 review round (B3-review-M-8 / L-1) ---

test('a domain named like a personal lane cannot re-open that lane (rule ORDER)', () => {
  // `sanitizeIdent` maps a domain called `personal_amir` to the schema `personal_amir` — the same
  // name as amir's lane. With the DOMAIN rules emitted first, its members owned amir's lane and its
  // SELECT fallthrough re-opened a schema `trino.rego` hard-denies. Lanes must come first.
  const rules = buildTrinoRules({
    serviceUsers: ['dbt-runner'],
    principalPattern: OS_PRINCIPAL_PATTERN,
    domains: [{ name: 'personal_amir', schema: 'personal_amir', principals: ['bea'] }],
    personalLanes: [{ uid: 'amir', schema: 'personal_amir' }],
  });
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'personal_amir'), true, 'the lane owner still owns it');
  assert.equal(schemaOwnerAllowed(rules, 'bea', 'personal_amir'), false, 'a member of the look-alike domain must NOT own the lane');
  assert.deepEqual(tablePrivilegesFor(rules, 'bea', 'personal_amir'), [], 'and must not even read it');
  assert.deepEqual(tablePrivilegesFor(rules, 'amir', 'personal_amir'), [...OWNER_PRIVILEGES]);
  // The order is visible in the document itself, which is what Trino reads.
  const firstLane = rules.schemas.findIndex((r) => r.schema === literal('personal_amir') && r.user === literal('amir'));
  const firstDomain = rules.schemas.findIndex((r) => r.user === '^(bea|personal_amir)$');
  assert.ok(firstLane >= 0 && firstDomain >= 0 && firstLane < firstDomain, 'personal-lane rules must precede domain rules');
});

test('the evaluator matches the WHOLE value, like Trino', () => {
  // Trino's file access control uses Pattern.matches (full match), so an unanchored fragment must
  // not match a longer string in our evaluator either.
  const rules: ReturnType<typeof buildTrinoRules> = {
    catalogs: [{ allow: 'all' }],
    schemas: [{ user: 'amir', schema: 'sales', owner: true }, { owner: false }],
    tables: [{ user: 'amir', schema: 'sales', privileges: ['SELECT'] }, { privileges: [] }],
    impersonation: [{ original_user: 'dbt', new_user: 'sales', allow: true }, { original_user: '.*', new_user: '.*', allow: false }],
  };
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'sales'), true);
  assert.equal(schemaOwnerAllowed(rules, 'amir2', 'sales'), false, 'a longer user must not match an unanchored fragment');
  assert.equal(schemaOwnerAllowed(rules, 'amir', 'sales_secret'), false, 'a longer schema must not match either');
  assert.deepEqual(tablePrivilegesFor(rules, 'amir-evil', 'sales'), []);
  assert.equal(impersonationAllowed(rules, 'dbt', 'sales'), true);
  assert.equal(impersonationAllowed(rules, 'dbt-evil', 'sales'), false);
  assert.equal(impersonationAllowed(rules, 'dbt', 'sales-other'), false);
});
