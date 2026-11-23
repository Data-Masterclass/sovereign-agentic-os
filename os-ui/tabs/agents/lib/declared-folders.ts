/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The folders an agent system names exist as soon as the system is defined
 * USER STORY: As an author I pick (or type a new) folder for "Where the results go" or grant my
 *             team a folder. I want that folder in my Knowledge / Files / Data folder list right
 *             after I save — not only once the first run has written something into it — and if
 *             I may not create it (a Domain folder needs a domain admin), I want to be told.
 * ARCHITECTURE:
 *   - `foldersNamedBy(system)` lists every (kind, scope, path) the definition names: each declared
 *     output's folder — plus the runner's personal lane at the same path for a Domain output,
 *     because that is where the engine writes before it requests the promotion
 *     (`output-saver.ts`) — and every folder grant of the Knowledge, Files and Data lists.
 *   - `materializeDeclaredFolders` creates each through the ONE folder door,
 *     `ensureFolderRow` (`@core/folders`), AS THE USER WHO SAVES/BUILDS: governed exactly like
 *     creating the folder by hand. A refusal is returned as a warning — the save still stands.
 *   - Called from the store's `system.yaml` save (`writeFile`) and again at Build (route + MCP)
 *     as a safety net. The stores keep their own ensure-on-write for the items themselves.
 */
import { normaliseFolderPath } from '@core/kernel/folders';
import { ensureFolderRow, type FolderTab, type Principal as FolderPrincipal } from '@core/folders/index';
import type { OutputKind, System } from '@tabs/agents/lib/system-schema';

export type NamedFolder = { kind: OutputKind; scope: 'personal' | 'domain'; path: string };

export type FolderWarning = NamedFolder & { status: number; reason: string; message: string };

export type FolderMaterialization = {
  /** Folder rows that exist now (created by this call or already there). */
  ensured: NamedFolder[];
  /** Folders that could not be created, each with the governed reason, in words. */
  warnings: FolderWarning[];
};

const TAB: Record<OutputKind, FolderTab> = { knowledge: 'knowledge', files: 'files', data: 'data' };
const LANE: Record<OutputKind, string> = { knowledge: 'knowledge', files: 'files', data: 'data' };

/** Every folder a system definition names, de-duplicated, root excluded (the root is implicit). */
export function foldersNamedBy(sys: System): NamedFolder[] {
  const out: NamedFolder[] = [];
  const add = (kind: OutputKind, scope: 'personal' | 'domain', raw: string) => {
    const path = normaliseFolderPath(raw);
    if (path === '/') return;
    if (out.some((f) => f.kind === kind && f.scope === scope && f.path === path)) return;
    out.push({ kind, scope, path });
  };
  for (const o of sys.outputs ?? []) {
    if (!o?.folder) continue;
    // A Domain output is written in the runner's own lane first, then promoted (output-saver.ts).
    add(o.kind, 'personal', o.folder.path);
    if (o.folder.scope === 'domain') add(o.kind, 'domain', o.folder.path);
  }
  for (const kind of ['knowledge', 'files', 'data'] as OutputKind[]) {
    for (const g of sys.grants?.[kind] ?? []) {
      if (g.folder) add(kind, g.folder.scope === 'domain' ? 'domain' : 'personal', g.folder.path);
    }
  }
  return out;
}

/**
 * Create the folder rows the definition names, as `user`, in the system's `domain`. Never throws
 * for a governed refusal: it comes back in `warnings` with a sentence the save / build result shows.
 */
export function materializeDeclaredFolders(sys: System, user: FolderPrincipal, domain: string): FolderMaterialization {
  const result: FolderMaterialization = { ensured: [], warnings: [] };
  for (const f of foldersNamedBy(sys)) {
    const r = ensureFolderRow(user, { tab: TAB[f.kind], scope: f.scope, path: f.path, domain });
    if (r.state === 'exists') result.ensured.push(f);
    else if (r.state === 'refused') {
      const where = `${f.scope === 'domain' ? 'Domain' : 'My'} ${LANE[f.kind]} ${f.path}`;
      result.warnings.push({
        ...f,
        status: r.status,
        reason: r.reason,
        message:
          `The folder ${where} was not created: ${r.reason}.` +
          (f.scope === 'domain' ? ' Ask a domain admin to create it, or choose a My folder.' : ''),
      });
    }
  }
  return result;
}
