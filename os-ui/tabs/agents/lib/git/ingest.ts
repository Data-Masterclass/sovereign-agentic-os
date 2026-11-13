/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `agents/<slug>/system.yaml` pushed by an engineer → the agent system in the registry
 * USER STORY: As an AI engineer I want to edit `system.yaml` in VS Code, `git push`, and see the
 *             agent system in the OS change exactly as if I had saved it in the builder — same
 *             validation, same version history, same files (E-R4.4, checklist E9).
 * ARCHITECTURE:
 *   - The Agents half of the `ingestFromRepo(kind, files)` contract. It REGISTERS the kind with
 *     `core/infra/git-receive.ts` (a core module may not import a tab), so the gate dispatches to
 *     this file without knowing anything about agent systems.
 *   - The validator is `parseSystem` — the SAME function `store.writeFile` calls when the builder
 *     saves `system.yaml`. Not a copy of it, not a second schema: one validator, two doors (D28).
 *   - The write goes through the governed store chokepoint (`writeFile` / `createSystem`), which
 *     re-gates edit scope, runs `assertGrantsWithinRole` and emits the commit — never a raw record
 *     mutation. Inside `runWithSurface('git:push')`, so the commit trailer says where it came from.
 *   - IDENTITY, NOT A DIRECTORY NAME: a path maps to a system through `agents/index.yml` (slug →
 *     frozen OS id), which is why that file is not pushable. A path the index does not know is a
 *     NEW system, created as the pusher and therefore Personal — a push can never publish to a
 *     domain audience, because audience is a governed promotion.
 *   - A file we cannot map and cannot create is SKIPPED with a note, never silently dropped.
 */
import { load } from 'js-yaml';
import { registerRepoKind, type ChangedFile, type IngestReport, type Pusher } from '@core/infra/git-receive';
import { runWithSurface } from '@core/infra/request-surface';
import { readBlob } from '@core/infra/git-store';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { createSystem, writeFile, type Principal } from '@tabs/agents/lib/store';

/** The `ingestFromRepo` key for this kind. */
export const AGENT_SYSTEM_KIND = 'agent-system';

/** `agents/<slug>/system.yaml` and `agents/personal/<owner>/<slug>/system.yaml`. */
export const SYSTEM_YAML_RE = /^agents\/(?:personal\/[^/]+\/)?[^/]+\/system\.yaml$/;

export function matchesAgentSystem(filePath: string): boolean {
  return SYSTEM_YAML_RE.test(filePath);
}

/** The ONE validator — `parseSystem`, exactly as the builder's save path calls it. */
export function validateSystemYaml(file: { path: string; content: string }): string | null {
  try {
    parseSystem(file.content);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type IndexEntry = { slug?: unknown; id?: unknown; path?: unknown };

/** `agents/index.yml` → directory → frozen OS system id. An unreadable index maps nothing. */
export function systemIdsByDir(indexYml: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = load(indexYml);
  } catch {
    return out;
  }
  const systems = (doc as { systems?: unknown } | null)?.systems;
  if (!Array.isArray(systems)) return out;
  for (const raw of systems as IndexEntry[]) {
    const dir = typeof raw?.path === 'string' ? raw.path.replace(/\/+$/, '') : '';
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (dir && id) out.set(dir, id);
  }
  return out;
}

/**
 * Apply the pushed `system.yaml` files. Reads the index at the PUSHED commit, so a push that adds
 * a system and (necessarily) leaves the index alone still resolves every pre-existing one.
 */
export async function ingestAgentSystems(
  input: {
    domain: string;
    files: ChangedFile[];
    pusher: Pusher;
    sha: string;
  },
  /** Test seam only: the repos directory to read `agents/index.yml` from. */
  deps: { reposDir?: string } = {},
): Promise<IngestReport> {
  const { domain, files, pusher, sha } = input;
  const report: IngestReport = { kind: AGENT_SYSTEM_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  let index = new Map<string, string>();
  try {
    index = systemIdsByDir(await readBlob(domain, sha, 'agents/index.yml', deps));
  } catch {
    report.notes.push('agents/index.yml is not in this commit — every pushed system is treated as new');
  }
  const principal: Principal = { id: pusher.id, domains: pusher.domains, role: pusher.role };

  for (const file of files) {
    if (file.status === 'deleted' || file.content === null) {
      // Deleting the file is NOT deleting the system: retirement is a governed action with its own
      // dependents check. Say so rather than acting on a guess.
      report.skipped += 1;
      report.notes.push(`${file.path} was removed from the repo; retire the system in the OS to delete it`);
      continue;
    }
    const dir = file.path.replace(/\/system\.yaml$/, '');
    const existingId = index.get(dir);
    try {
      runWithSurface('git:push', () => {
        if (existingId) {
          writeFile(existingId, principal, { path: 'system.yaml', content: file.content!, sha: '' });
          report.updated += 1;
        } else {
          const parsed = parseSystem(file.content!);
          createSystem(principal, { name: parsed.system.name || dir.split('/').pop() || 'Untitled system', domain, yaml: file.content! });
          report.created += 1;
        }
      });
    } catch (e) {
      report.skipped += 1;
      report.notes.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

/** Register this kind with the receive gate. Idempotent; called from the boot step. */
export function registerAgentSystemIngest(): void {
  registerRepoKind({
    kind: AGENT_SYSTEM_KIND,
    matches: matchesAgentSystem,
    validate: validateSystemYaml,
    ingest: ingestAgentSystems,
  });
}
