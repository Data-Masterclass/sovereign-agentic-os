/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The generic git reads over MCP — `get_history`, `get_version`, `diff_versions`
 * USER STORY: As an engineer working from Claude I want to ask which commit any OS object is at,
 *             read its files at an older commit and diff two versions — with `{kind, id}` and
 *             nothing tab-specific — reaching the SAME module the UI's history drawer calls
 *             (checklist G7).
 * ARCHITECTURE:
 *   - THIN wrappers over `core/infra/git-objects.ts`. No second code path, no second gate: the
 *     owner/scope check is the owning tab's own governed read, run as the CALLER by the resolver
 *     the tab registered at boot. A parity test asserts tool output === module output.
 *   - A kind whose tab has not registered a resolver cannot be looked up at all, so the tool
 *     answers the OS's `not_found` (404) and keeps the module's explanatory reason — the
 *     registry's own 501 `kind_not_wired` is for the UI and the operator, while a client gets the
 *     one refusal every object-addressed tool in this OS owes (`mcp-conformance.test.ts`).
 *   - READ-ONLY. `restore_version` is deliberately NOT here: a restore must go back through each
 *     kind's normal writer, no tab has registered one yet, and a write tool whose only possible
 *     answer is a refusal would be noise in the write-approval catalogue (deviation G-2).
 *   - Server-only: reaches node:fs through the git store.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import type { CurrentUser } from '@core/kernel/auth';
import {
  GIT_OBJECT_KINDS,
  GIT_OBJECT_LAYOUT,
  GitObjectError,
  objectGitInfo,
  getVersion,
  diffVersions,
  isGitObjectKind,
  notFoundMessage,
  type GitObjectKind,
  type GitStoreOptionsLike,
} from '@core/infra/git-objects';

/** Test seam: point every tool at a temp repos directory (never used in production code). */
let reposDirOverride: string | null = null;
export function __setGitToolsReposDirForTests(dir: string | null): void {
  reposDirOverride = dir;
}
function opts(): GitStoreOptionsLike {
  return reposDirOverride ? { reposDir: reposDirOverride } : {};
}

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** `{kind, id}` — the two arguments every tool here takes, validated identically. */
function target(args: Record<string, unknown>, tool: string): { kind: GitObjectKind; id: string } {
  const kind = str(args.kind);
  const id = str(args.id);
  if (!kind || !id) fail(`${tool} needs a \`kind\` (${GIT_OBJECT_KINDS.join(' | ')}) and an \`id\``, 400);
  if (!isGitObjectKind(kind)) fail(`'${kind.slice(0, 40)}' is not an object kind — one of ${GIT_OBJECT_KINDS.join(', ')}`, 400);
  return { kind, id };
}

/**
 * Run a read and keep the OS's refusal vocabulary. A kind nobody wired is `not_found` to a
 * client — with the module's reason, so the gap is still named rather than hidden.
 */
async function governed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof GitObjectError && e.code === 'kind_not_wired') fail(e.message, 404);
    throw e;
  }
}

/** The property shape JSON Schema wants for a scalar — `JsonSchema` itself is object-only. */
const TARGET_PROPS: Record<string, unknown> = {
  kind: {
    type: 'string',
    enum: [...GIT_OBJECT_KINDS],
    description: 'The object kind — dataset (dbt model) · metric (dbt metric) · dashboard · agent-system (LangGraph) · software (app) · lifecycle-pin.',
  },
  id: { type: 'string', description: 'The object id, as its own tab returns it (never a slug or a directory name).' },
};

/** The layout table as one readable line per kind, for the tool descriptions. */
const LAYOUT_HINT = GIT_OBJECT_KINDS.map((k) => `${k} → ${GIT_OBJECT_LAYOUT[k].paths.join(', ')}`).join(' · ');

export const GIT_TOOLS: McpTool[] = [
  {
    name: 'get_history',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Read the git history of ANY OS object: the commit it is at (sha, author, time, action, surface) and its recent commits, from the domain repository itself. Purpose: "which version is this, who changed it and why" for a dbt model, a dbt metric, a dashboard, a LangGraph system or an app — one tool, one answer shape. Before: the tab\'s own list/get tool, for the id. After: get_version(sha) to read the files, diff_versions(a, b) to see what changed. Governance: read-only; the owning tab\'s own visibility check runs as YOU, and an object you cannot see answers the same `not_found` as one that does not exist. HONESTY: `truncated: true` means the bounded scan window ran out, not that the history is complete; `via` says whether the answer came from the commit trailer, from the path log, or both. ' +
      `Repo layout: ${LAYOUT_HINT}.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        limit: { type: 'number', description: 'Commits to return (default 10, capped 100).' },
      },
      required: ['kind', 'id'],
      examples: [
        { kind: 'agent-system', id: 'sys_7f3a' },
        { kind: 'dataset', id: 'ds_1b2c', limit: 25 },
      ],
    },
    call: async (user: CurrentUser, args) => {
      const { kind, id } = target(args, 'get_history');
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : undefined;
      return governed(() => objectGitInfo(user, kind, id, { ...opts(), ...(limit ? { limit } : {}) }));
    },
  },
  {
    name: 'get_version',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Read ONE version of an OS object: every file of it exactly as it was at a commit, plus the commit that made it. Purpose: see the real bytes (the dbt YAML, the system.yaml, the dashboard-as-code file) rather than a paraphrase of them. Before: get_history, for the sha. After: diff_versions to compare two. Governance: read-only, gated exactly as get_history; an object you cannot see and one that never existed answer identically. REDACTION: anything secret-shaped (a `password:`/`token:`/`api_key:` value, a PEM private key, a credential in a URL, a provider key) is replaced with `***REDACTED-BY-OS***` before the bytes leave the server; `redacted: true` and `redactedPaths` say exactly which files were altered and by which pattern, so you never read a redacted file as if it were the original. A RESTORE re-applies the real bytes, never the redacted ones. HONESTY: `present: false` means the object had NO files at that commit — a real answer, not an error; `binary: true` on a file means it is a binary blob, reported with its size and an EMPTY content rather than decoded as text; `truncated`/`truncatedBy` say when the version holds more files or bytes than one read returns.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        sha: { type: 'string', description: 'A commit sha (full or abbreviated), from get_history. Not a ref expression.' },
      },
      required: ['kind', 'id', 'sha'],
      examples: [{ kind: 'agent-system', id: 'sys_7f3a', sha: '9c1f2ab' }],
    },
    call: async (user: CurrentUser, args) => {
      const { kind, id } = target(args, 'get_version');
      const sha = str(args.sha);
      if (!sha) fail('get_version needs a `sha` (from get_history)', 400);
      return governed(() => getVersion(user, kind, id, sha, opts()));
    },
  },
  {
    name: 'diff_versions',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Diff an OS object between two commits — a unified diff per changed file, and the concatenated patch an engineer could pipe into `git apply`. Purpose: answer "what actually changed between these two versions" in the tool\'s own format, with no OS-invented diff view. Before: get_history, for the two shas. After: act on the change, or ask the tab for the current state. Governance: read-only, gated exactly as get_history. REDACTION: the same secret scrub as get_version runs over every patch, and `redacted: true` says so; the COMPARE still runs on the raw bytes, so a change that is entirely inside redacted content is reported as a redacted change rather than as "no change". HONESTY: `identical: true` (and `files: []`) means the object is byte-identical at both commits; a binary file is reported as `Binary files … differ` instead of as bytes; a file too large to diff line-by-line is reported as such instead of being silently skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        shaA: { type: 'string', description: 'The OLDER commit sha (full or abbreviated).' },
        shaB: { type: 'string', description: 'The NEWER commit sha (full or abbreviated).' },
      },
      required: ['kind', 'id', 'shaA', 'shaB'],
      examples: [{ kind: 'dataset', id: 'ds_1b2c', shaA: '3f81d0c', shaB: '9c1f2ab' }],
    },
    call: async (user: CurrentUser, args) => {
      const { kind, id } = target(args, 'diff_versions');
      const shaA = str(args.shaA);
      const shaB = str(args.shaB);
      if (!shaA || !shaB) fail('diff_versions needs `shaA` and `shaB` (from get_history)', 400);
      return governed(() => diffVersions(user, kind, id, shaA, shaB, opts()));
    },
  },
];

/** The `not_found` reason a client sees for an object it may not see — exported for the tests. */
export const gitNotFound = notFoundMessage;
