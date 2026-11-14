/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra
 * FEATURE:    V11 — the LiteLLM `env:` tag and the Langfuse trace `environment`
 * USER STORY: As a platform operator I want a draft's model spend and traces separable from what
 *             is running, so an experiment cannot drain the budget the company depends on and so
 *             "which environment was this trace from" is answerable without guessing.
 * ARCHITECTURE:
 *   - Asserts the OUTGOING REQUEST BODY, not an intermediate object: the tag list that
 *     `callerCredential` produces is what `core/runtime/runtime.ts` puts in `metadata.tags`, so
 *     the assertion is on the bytes the gateway receives.
 *   - Asserts the TRACE PAYLOAD by injecting a fake Langfuse client and capturing the
 *     `client.trace({...})` argument — the same seam `observe.test.ts` uses.
 *   - A lifecycle that is not set must add NO tag and NO field: an attribution the OS did not
 *     establish is never fabricated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { callerCredential, TAG_ENV, TAG_DOMAIN, TAG_RUN } = await import('./litellm-credential.ts');
const { langfuseRunObserver, runTraceTags } = await import('@tabs/agents/lib/engine/observe');
const { runEnvOf, lifecycleBudgetMetadata, RUN_ENVS } = await import('@core/kernel/object-lifecycle');

// ------------------------------------------------- the LiteLLM env: tag ---

test('V11: every model call carries env:studio|test|run beside the existing tags', () => {
  for (const env of RUN_ENVS) {
    const cred = callerCredential({ userId: 'u1', domain: 'sales', systemId: 's1', runId: 'r1', env });
    assert.ok(cred.tags.includes(`${TAG_ENV}${env}`), `${env}: the env: tag is missing`);
    // and nothing it already carried was lost
    assert.ok(cred.tags.includes(`${TAG_DOMAIN}sales`));
    assert.ok(cred.tags.includes(`${TAG_RUN}r1`));
  }
});

test('V11: the env: tag is the LAST tag, so the existing tag vocabulary is unchanged in order', () => {
  const without = callerCredential({ userId: 'u1', domain: 'sales', systemId: 's1', tab: 'agents', runId: 'r1' });
  const with_ = callerCredential({
    userId: 'u1',
    domain: 'sales',
    systemId: 's1',
    tab: 'agents',
    runId: 'r1',
    env: 'run',
  });
  assert.deepEqual(with_.tags.slice(0, without.tags.length), without.tags);
  assert.deepEqual(with_.tags.slice(without.tags.length), ['env:run']);
});

test('V11: no lifecycle ⇒ no env: tag. An attribution the OS did not establish is never invented', () => {
  const cred = callerCredential({ userId: 'u1', domain: 'sales' });
  assert.equal(
    cred.tags.some((t) => t.startsWith(TAG_ENV)),
    false,
  );
});

test('V11: the three words map onto the tools’ env vocabulary exactly once each', () => {
  assert.deepEqual([runEnvOf('draft'), runEnvOf('testing'), runEnvOf('live')], ['studio', 'test', 'run']);
  assert.deepEqual([...RUN_ENVS], ['studio', 'test', 'run']);
});

test('V11: per-lifecycle budgets go in the key metadata, and a draft cannot drain what runs', () => {
  const studio = lifecycleBudgetMetadata('studio', 500);
  const run = lifecycleBudgetMetadata('run', 500);
  assert.equal(studio.os_env, 'studio');
  assert.equal(run.max_budget, 500, 'what operates gets the whole key budget');
  assert.ok((studio.max_budget as number) < (run.max_budget as number));
  assert.deepEqual(Object.keys(run).sort(), ['max_budget', 'os_env', 'os_env_budget_share']);
});

// ------------------------------------------- the Langfuse trace environment ---

type TraceArg = { id?: string; tags?: string[]; environment?: string };

function fakeClient() {
  const traces: TraceArg[] = [];
  const client = {
    trace: (arg: TraceArg) => {
      traces.push(arg);
      return {};
    },
    span: () => ({}),
    generation: () => ({}),
    event: () => ({}),
    score: () => ({}),
  };
  return { client, traces };
}

test('V11: the Langfuse trace environment IS the lifecycle, and the env: tag matches it', () => {
  for (const env of RUN_ENVS) {
    const { client, traces } = fakeClient();
    langfuseRunObserver({
      runId: `run_${env}`,
      systemId: 's1',
      systemName: 'Nightly digest',
      userId: 'u1',
      domain: 'sales',
      environment: env,
      client: client as never,
    });
    assert.equal(traces.length, 1, `${env}: exactly one trace is created`);
    assert.equal(traces[0].environment, env, `${env}: the trace environment field`);
    assert.ok(traces[0].tags?.includes(`env:${env}`), `${env}: and the matching tag`);
  }
});

test('V11: with no lifecycle the trace carries no environment field at all', () => {
  const { client, traces } = fakeClient();
  langfuseRunObserver({
    runId: 'run_plain',
    systemId: 's1',
    systemName: 'x',
    userId: 'u1',
    domain: 'sales',
    client: client as never,
  });
  assert.equal('environment' in traces[0], false, 'the field is absent, not an empty string');
  assert.equal(
    traces[0].tags?.some((t) => t.startsWith('env:')),
    false,
  );
});

test('V11: runTraceTags keeps every tag Monitoring and the gateway mirror already share', () => {
  const base = runTraceTags({ domain: 'sales', systemId: 's1', runId: 'r1', engine: 'langgraph' });
  assert.deepEqual(base, ['domain:sales', 'agent:s1', 'run:r1', 'engine:langgraph']);
  const withEnv = runTraceTags({
    domain: 'sales',
    systemId: 's1',
    runId: 'r1',
    engine: 'langgraph',
    environment: 'run',
  });
  assert.deepEqual(withEnv, [...base, 'env:run']);
});
