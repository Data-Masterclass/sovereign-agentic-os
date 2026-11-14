/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    THE COIN TEST (plan X-R8 / checklist X8) — one change, two doors, one outcome
 * USER STORY: As the product owner I said "from one side it looks like an engineering coin, from
 *             the other a business-user coin, but at the end it's the same coin". This file is the
 *             literal test of that: for each object kind, the same change made (a) through its MCP
 *             tool and (b) by a `git push` must leave BYTE-IDENTICAL FILES in the domain repo, an
 *             IDENTICAL REGISTRY STATE, and an IDENTICAL HISTORY ENTRY except `OS-Surface`
 *             (`mcp:<tool>` vs `git:push`).
 * ARCHITECTURE:
 *   - TABLE-DRIVEN over kinds, so adding a kind is adding a row: `agent_system` and `dataset`
 *     tonight (the plan's two), `metric` and `dashboard` when M and D land their formats.
 *   - A REAL bare repository per case (`mkdtemp`), the REAL commit path and the REAL generator —
 *     nothing about the file bytes is faked, because the bytes are the thing being compared.
 *   - THE MCP SIDE RUNS FOR REAL TONIGHT. It is driven through `handleRpc` exactly as a client
 *     would, which is also what stamps `OS-Surface: mcp:<tool>`, and the three observations are
 *     captured from the repo and the store, never from the tool's own return value.
 *   - THE PUSH SIDE IS STREAM E's (`reconcileFromGit(domain, fromSha, toSha)` +
 *     `ingestFromRepo(kind, files)`, plan E deliverable 3). It is written against that contract
 *     and resolved by DYNAMIC IMPORT: while E has not merged, the comparison cases report `todo`
 *     naming the missing export — they are never silently skipped and never falsely green.
 *     When E lands, only `loadReceive()` resolves differently; no assertion changes.
 *   - The *fake receive* is the one E's brief specifies: a real bare repo, a synthetic commit
 *     authored as the pusher, the ingest called directly. No network, no http-backend.
 *   - WHY IT LIVES UNDER `tabs/agents/` (review H-1). It drives the Agents store and the agents
 *     git subtree, so in `core/mcp/` it was a `core → @tabs/*` import: three new
 *     CORE-INDEPENDENCE violations and `check-structure` exit 1. A TAB may import `@core/*`, so
 *     the same file is legal here and the ratchet baseline stays where it was. When the `dataset`
 *     row goes live it will need `@tabs/data/*` too — a tab importing a second tab is also
 *     forbidden, so the kind table will then have to split one file per tab, sharing this
 *     harness through a `@core`-only helper. Recorded in the plan as deviation X-13.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse } from '@core/mcp/server';
import { commitTree, listTree, readBlob, log, __clearReservedSubtrees } from '@core/infra/git-store';
import * as agents from '@tabs/agents/lib/store';
import { __resetSystemListeners } from '@tabs/agents/lib/system-events';
import {
  installAgentProjectCommitHook,
  awaitAgentProjectCommits,
  __setAgentProjectGitForTests,
} from '@tabs/agents/lib/git/commit';

/* ------------------------------------------------------------------ the contract -- */

/**
 * Stream E's post-receive ingest, exactly as the plan states it. Kept as a type so this file
 * compiles and documents the contract whether or not the module exists yet.
 */
type ReceiveModule = {
  reconcileFromGit: (
    domain: string,
    fromSha: string | null,
    toSha: string,
    opts?: { reposDir?: string; pusher?: { id: string } },
  ) => Promise<unknown>;
};

/** Where stream E's ingest may live. Both are checked, and both must be absent to report `todo`. */
const RECEIVE_CANDIDATES = ['core/infra/git-receive.ts', 'core/infra/git-ingest.ts'] as const;
const OS_UI_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Resolve E's ingest, or say precisely what is missing.
 *
 * Review L-4: ABSENT and BROKEN are different answers. A module that exists but throws on import,
 * or that exists without the export, used to be swallowed by the `catch` and reported as "not in
 * the tree yet" — so a merge that half-landed E's ingest would have turned the coin test green-ish
 * and silent. Now: the file not existing on disk is the ONLY thing that yields `todo`; anything
 * else — an import error, a missing export — is rethrown and FAILS the test.
 */
async function loadReceive(): Promise<{ mod: ReceiveModule } | { missing: string }> {
  const present = RECEIVE_CANDIDATES.filter((rel) => existsSync(join(OS_UI_ROOT, rel)));
  if (present.length === 0) {
    return {
      missing:
        "reconcileFromGit(domain, fromSha, toSha) is not in this tree — it is stream E's deliverable 3 " +
        `(neither ${RECEIVE_CANDIDATES.join(' nor ')} exists; plan 2026-11-14 §Phase E). The comparison ` +
        'below is written against that signature and runs unchanged once E merges.',
    };
  }
  // From here on, a failure is a FAILURE. No catch.
  const rel = present[0];
  const mod = (await import(`@core/${rel.replace(/^core\//, '').replace(/\.ts$/, '')}`)) as Partial<ReceiveModule>;
  assert.equal(
    typeof mod.reconcileFromGit,
    'function',
    `${rel} exists but exports no reconcileFromGit — the coin test cannot be satisfied by a half-landed ingest`,
  );
  return { mod: mod as ReceiveModule };
}

/* ---------------------------------------------------------------- observations -- */

/** The three things the coin test compares. */
type Side = {
  /** Every repo path under the kind's prefix → its exact, UNSCRUBBED bytes (the push replays these). */
  files: [string, string][];
  /** The registry state the door left, normalised. */
  registry: unknown;
  /** The newest commit's subject + trailers, normalised. */
  history: Record<string, string>;
  /** Push side only: the repo head after the ingest, and the sha the push created. */
  headSha?: string;
  pushedSha?: string;
};

const ID_RE = /\b(?:sys|ds|met|dash)_[A-Za-z0-9_-]+/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const SHA_RE = /\b[0-9a-f]{40}\b/g;

/** Ids and timestamps are minted per run; everything else must be equal. */
function scrub(text: string): string {
  return text.replace(ID_RE, '<ID>').replace(ISO_RE, '<TS>').replace(SHA_RE, '<SHA>');
}

async function repoFiles(domain: string, prefix: string, reposDir: string): Promise<[string, string][]> {
  const tree = (await listTree(domain, 'main', { reposDir })).filter((e) => e.path.startsWith(prefix));
  const out: [string, string][] = [];
  for (const e of tree.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    out.push([e.path, await readBlob(domain, 'main', e.path, { reposDir })]);
  }
  return out;
}

/**
 * Files, with the per-run ids and timestamps masked — for the COMPARISON only. The push replays
 * the raw bytes, so what is compared is still the real output of both doors, with only the two
 * things that cannot be equal across two runs (a minted id, a clock) neutralised.
 */
function comparableFiles(files: [string, string][]): [string, string][] {
  return files.map(([path, body]) => [scrub(path), scrub(body)]);
}

async function newestHistory(domain: string, reposDir: string): Promise<Record<string, string>> {
  const [head] = await log(domain, { reposDir, limit: 1 });
  assert.ok(head, 'the door committed nothing at all');
  return {
    // `via <surface>` is the ONE half of the subject allowed to differ, so it is split out.
    subject: scrub(head.subject.replace(/ — via .*$/, '')),
    'OS-Action': scrub(head.trailers['OS-Action'] ?? ''),
    'OS-Object': scrub(head.trailers['OS-Object'] ?? ''),
    'OS-Actor': head.trailers['OS-Actor'] ?? '',
    // The deliberate difference, asserted separately.
    'OS-Surface': head.trailers['OS-Surface'] ?? '',
  };
}

/* ------------------------------------------------------------------- the kinds -- */

const pusher: CurrentUser = { id: 'amir', name: 'Amir Example', domains: ['sales'], role: 'creator' };
const DOMAIN = 'sales';

const SYSTEM_YAML = `version: '1'
system:
  name: Coin check
  domain: sales
  visibility: Personal
entrypoint: analyst
state:
  channels:
    messages: add_messages
grants:
  data: []
  knowledge: []
  metrics: []
  tools: []
  connections: []
agents:
  - id: analyst
    role: Reads the granted data and answers
    agent_md: |
      # analyst
      Answer from the granted data only.
    memory_md: '# Memory'
    tools: []
`;

type Kind = {
  /** The registry kind `ingestFromRepo` is called with. */
  kind: string;
  /** Repo prefix the kind owns. */
  prefix: string;
  /** The MCP tool whose surface the commit must carry. */
  tool: string;
  /** Reset every store this kind touches. */
  reset: () => void;
  /** Install the kind's commit hook against a real repo. Returns the uninstaller. */
  install: (reposDir: string) => () => void;
  /** Drain the kind's in-flight commits. */
  drain: () => Promise<void>;
  /** Make the change over the MCP, as a client would. */
  viaMcp: (user: CurrentUser) => Promise<void>;
  /** The registry state, normalised — the cache the files are authoritative over. */
  registry: () => unknown;
  /** Why this kind is not in the table yet (absent ⇒ it is). */
  blocked?: string;
};

async function rpc(user: CurrentUser, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `no result for ${name}`);
  const result = (res as JsonRpcResponse).result as Record<string, unknown>;
  assert.notEqual(result.isError, true, `${name} failed: ${(result.content as { text: string }[])?.[0]?.text}`);
  return JSON.parse((result.content as { text: string }[])[0].text) as Record<string, unknown>;
}

const KINDS: Kind[] = [
  {
    kind: 'agent_system',
    prefix: 'agents/',
    tool: 'commit_agent_files',
    reset: () => {
      agents.__resetStore();
      __resetSystemListeners();
    },
    install: (reposDir) => installAgentProjectCommitHook({ reposDir, mirror: false, resolveActor: async (id) => ({ id, name: 'Amir Example', email: 'amir@example.com' }) }),
    drain: awaitAgentProjectCommits,
    viaMcp: async (user) => {
      const created = await rpc(user, 'create_agent_system', { name: 'Coin check', domain: DOMAIN });
      await awaitAgentProjectCommits();
      await rpc(user, 'commit_agent_files', { systemId: created.id, path: 'system.yaml', content: SYSTEM_YAML });
    },
    registry: () => {
      const { mine } = agents.listSystems(pusher);
      return mine
        .map((s) => ({ name: s.name, visibility: s.visibility, domain: s.domain }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  {
    kind: 'dataset',
    prefix: 'models/',
    tool: 'create_dataset',
    reset: () => {},
    install: () => () => {},
    drain: async () => {},
    viaMcp: async () => {},
    registry: () => null,
    blocked:
      'the dataset half needs E\'s dbt ingest (tabs/data/lib/dbt/ingest.ts: models + schema.yml → ' +
      'dataset records) as well as reconcileFromGit; the MCP half already has its own parity suite ' +
      'in tabs/data/lib/mcp-parity.test.ts, which this test does not duplicate.',
  },
];

/* ---------------------------------------------------------------------- driver -- */

let reposDir = '';
let uninstall: (() => void) | null = null;

beforeEach(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-coin-'));
  __clearReservedSubtrees();
  __setAgentProjectGitForTests(true);
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  __setAgentProjectGitForTests(null);
  __clearReservedSubtrees();
  rmSync(reposDir, { recursive: true, force: true });
});

/** Door (a): the business-user side of the coin. */
async function mcpSide(k: Kind): Promise<Side> {
  k.reset();
  uninstall = k.install(reposDir);
  await k.viaMcp(pusher);
  await k.drain();
  return { files: await repoFiles(DOMAIN, k.prefix, reposDir), registry: k.registry(), history: await newestHistory(DOMAIN, reposDir) };
}

/**
 * Door (b): the engineering side. A *fake receive* — the pusher's own bytes land in a real bare
 * repo as a real commit, then the OS's post-receive ingest is called directly, exactly as E's
 * brief specifies. The OS must not rewrite the human's bytes and must derive the same registry.
 */
async function pushSide(k: Kind, mod: ReceiveModule, files: Map<string, string>): Promise<Side> {
  k.reset();
  const before = await log(DOMAIN, { reposDir, limit: 1 });
  // What an engineer's `git push` from VS Code actually looks like: the human's own subject, and
  // only the two trailers the RECEIVE GATE is specified to record (the resolved principal and the
  // surface). Nothing is pre-loaded with the MCP side's wording — that would make the comparison
  // circular.
  const commit = await commitTree(DOMAIN, files, {
    author: { name: 'Amir Example', email: 'amir@example.com' },
    message: 'add the coin-check system',
    trailers: { 'OS-Actor': pusher.id, 'OS-Surface': 'git:push' },
    reposDir,
  });
  await mod.reconcileFromGit(DOMAIN, before[0]?.sha ?? null, commit.sha, { reposDir, pusher: { id: pusher.id } });
  return {
    files: await repoFiles(DOMAIN, k.prefix, reposDir),
    registry: k.registry(),
    history: await newestHistory(DOMAIN, reposDir),
    headSha: (await log(DOMAIN, { reposDir, limit: 1 }))[0]?.sha ?? '',
    pushedSha: commit.sha,
  };
}

for (const k of KINDS) {
  // ---- what runs tonight, per kind: the MCP side, for real ----
  test(`coin test [${k.kind}]: the MCP door writes the files, the registry and the history entry`, async (t) => {
    if (k.blocked) {
      t.todo(k.blocked);
      return;
    }
    const side = await mcpSide(k);
    assert.ok(side.files.length > 0, 'the MCP door committed files under the kind\'s prefix');
    assert.ok(
      side.files.some(([p]) => p.endsWith('/system.yaml') || p.endsWith('schema.yml')),
      'including the authoritative source file an engineer would edit',
    );
    assert.equal(side.history['OS-Surface'], `mcp:${k.tool}`, 'the history entry names the MCP tool as its surface');
    assert.equal(side.history['OS-Actor'], pusher.id, 'and attributes the acting user, not a service principal');
    assert.notDeepEqual(side.registry, null, 'the registry is populated');
  });

  // ---- the comparison itself: needs E's push half ----
  test(`coin test [${k.kind}]: MCP and git push leave identical files, registry and history`, async (t) => {
    if (k.blocked) {
      t.todo(k.blocked);
      return;
    }
    const receive = await loadReceive();
    if ('missing' in receive) {
      t.todo(receive.missing);
      return;
    }
    const mcp = await mcpSide(k);
    // Review L-4: two nulls compare equal, so an empty registry on both sides would satisfy
    // clause (2) while proving nothing. Refuse to compare a registry that is not there.
    assert.notEqual(mcp.registry, null, 'the MCP side left a registry state to compare against');
    assert.notDeepEqual(mcp.registry, [], 'and it is not empty');
    uninstall?.();
    uninstall = null;
    // Fresh repo + fresh store: the push starts from nothing, like a clone-and-push would.
    rmSync(reposDir, { recursive: true, force: true });
    reposDir = mkdtempSync(join(tmpdir(), 'os-coin-push-'));
    const push = await pushSide(k, receive.mod, new Map(mcp.files));

    // (1) BYTE-IDENTICAL FILES — the OS never rewrites a human's bytes into its own spelling.
    assert.deepEqual(comparableFiles(push.files), comparableFiles(mcp.files), 'the two doors leave byte-identical files');
    // (2) IDENTICAL REGISTRY STATE — the row is a cache of the file, so it cannot differ.
    assert.deepEqual(push.registry, mcp.registry, 'the two doors leave the registry in the same state');
    // (3) THE HISTORY ENTRY — see DEVIATION X-1 in the plan for why this clause is stated as
    // actor + surface + no-rewrite, and not as a literal field-by-field equality of the subject.
    // On the MCP side the OS authors the commit, so it writes its own subject and `OS-Object`. On
    // the push side the commit is the HUMAN's, and the plan's own hard rule is that "the OS never
    // rewrites a human's history" — so the OS cannot amend that subject into the OS's wording. The
    // invariants that DO hold, and that a drifting implementation would break, are asserted here.
    assert.equal(mcp.history['OS-Surface'], `mcp:${k.tool}`, 'the MCP commit names its tool');
    assert.equal(push.history['OS-Surface'], 'git:push', 'the pushed commit is recorded as a push');
    assert.equal(push.history['OS-Actor'], mcp.history['OS-Actor'], 'both doors attribute the SAME principal');
    assert.equal(push.history['OS-Actor'], pusher.id, 'and it is the acting human, never a service principal');
    assert.equal(push.headSha, push.pushedSha, "the ingest added no commit of its own: the push IS the new head, so the human's history is intact");
    // Where the receive gate DOES record the OS attribution trailers, they must agree with the
    // MCP side's — a push that classified the object differently would be a real divergence.
    if (push.history['OS-Object']) {
      assert.equal(push.history['OS-Object'], mcp.history['OS-Object'], 'the same object is attributed by both doors');
    }
  });
}

test('coin test: the table names every kind, and says why a kind is not in it yet', () => {
  // The X1-style enumeration: a kind may be absent, but never silently.
  assert.deepEqual(KINDS.map((k) => k.kind), ['agent_system', 'dataset'], 'tonight\'s two kinds, per the plan');
  for (const k of KINDS) {
    if (k.blocked) assert.ok(k.blocked.trim().length > 40, `${k.kind} states a reason, not a shrug`);
  }
  // `metric` and `dashboard` join when M and D land their formats (plan X-R8) — recorded here so
  // the omission is visible in the test, not only in the plan.
  const later = ['metric', 'dashboard'];
  for (const kind of later) assert.equal(KINDS.some((k) => k.kind === kind), false, `${kind} arrives with its format`);
});
