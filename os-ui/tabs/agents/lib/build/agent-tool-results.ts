/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    What an AGENT gets back from a governed tool — scoped to its grant and compact
 * USER STORY: As the owner of an agent system that was granted ONE folder I want `list_files` to
 *             show my agent the files in that folder — not every file I can see, with all its
 *             metadata — so the agent finds its work at once and the listing does not sit in the
 *             conversation, re-sent on every following step, costing thousands of tokens each time.
 * ARCHITECTURE:
 *   - THE AGENT PATH ONLY. This shapes the TEXT a tool result becomes for the model inside
 *     `grantedToolExecutor`. The MCP tool itself, and therefore what a person in the UI or an
 *     external MCP client gets from it, is untouched.
 *   - NEVER WIDENS. The input is the result the governed tool already returned for the running
 *     user (DLS-filtered); shaping only removes rows and fields. A folder grant narrows the
 *     listing to the grant's own lane (`personal` → the runner's My files, `domain` → Domain
 *     files) and folder subtree — the same rule `resolveFolderGrant` uses.
 *   - `list_files`: rows as `{ id, name, folder, kind, bytes, status, description }` under `items`
 *     (so the engine's row-aware truncation applies), with a `scope` sentence saying what the
 *     listing is limited to. No facets, deep links, owners, versions or other tiers.
 *   - `get_file`: the metadata an agent reasons with plus the text; the version history and the
 *     object-store record are dropped.
 *   - EVERY JSON result is re-serialised without indentation: the MCP door pretty-prints for
 *     people (`JSON.stringify(result, null, 2)`), and that whitespace is a quarter of the tokens.
 *   - Pure; anything that does not parse as JSON, and every error result, passes through unchanged.
 */
import { isUnderFolder, normaliseFolderPath } from '@core/kernel/folders';
import type { FolderGrantTarget } from '@tabs/agents/lib/system-schema';

/** Cap on a file's description in an agent's listing. */
const DESCRIPTION_MAX_CHARS = 140;

export type AgentResultContext = {
  /** The system's FILES folder grants (`grants.files[].folder`). Empty → the runner's whole view. */
  filesFolders: FolderGrantTarget[];
};

type Row = Record<string, unknown>;

const isRecord = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const LANE_LABEL: Record<FolderGrantTarget['scope'], string> = { personal: 'My files', domain: 'Domain files' };

/** "/Invoices (My files)" — how a folder grant is named to the model. */
export function describeFolderGrant(g: FolderGrantTarget): string {
  return `${normaliseFolderPath(g.path)} (${LANE_LABEL[g.scope]})`;
}

function compactFile(row: Row, tier?: string): Row {
  const out: Row = {
    id: row.id,
    name: row.name,
    folder: row.folder,
    kind: row.kind,
    bytes: row.bytes,
    status: row.status,
  };
  const description = str(row.description);
  if (description) out.description = shorten(description, DESCRIPTION_MAX_CHARS);
  if (tier) out.tier = tier;
  return out;
}

/**
 * The agent's view of a `list_files` result: only the files the system's folder grant(s) cover
 * (or, with no folder grant, everything the runner sees, labelled by tier), optionally narrowed
 * further to the `folder` the agent asked for, as compact rows.
 */
export function shapeFileListing(result: unknown, args: Record<string, unknown>, ctx: AgentResultContext): unknown {
  if (!isRecord(result)) return result;
  const lanes: Record<FolderGrantTarget['scope'] | 'company', Row[]> = {
    personal: rowsOf(result.mine),
    domain: rowsOf(result.domain),
    company: rowsOf(result.marketplace),
  };
  const asked = typeof args.folder === 'string' && args.folder.trim() ? normaliseFolderPath(args.folder) : null;
  const inAsked = (row: Row) => !asked || isUnderFolder(asked, str(row.folder));

  const grants = ctx.filesFolders;
  const items: Row[] = [];
  const seen = new Set<string>();
  const push = (row: Row, tier?: string) => {
    const id = str(row.id);
    if (!id || seen.has(id) || !inAsked(row)) return;
    seen.add(id);
    items.push(compactFile(row, tier));
  };
  let scope: string;
  if (grants.length > 0) {
    for (const g of grants) for (const row of lanes[g.scope]) if (isUnderFolder(g.path, str(row.folder))) push(row);
    scope = `Limited to the folder${grants.length === 1 ? '' : 's'} this system was granted: ${grants.map(describeFolderGrant).join(', ')}. Other files are not part of this system's work.`;
  } else {
    for (const row of lanes.personal) push(row, 'my');
    for (const row of lanes.domain) push(row, 'domain');
    for (const row of lanes.company) push(row, 'company');
    scope = 'Every file the running user can see (this system has no folder grant).';
  }
  return { scope, ...(asked ? { folder: asked } : {}), count: items.length, items };
}

/** The agent's view of a `get_file` result: metadata + text, without the version history and object record. */
export function shapeFile(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const out: Row = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'history' || k === 'object' || k === 'owner' || k === 'visibility') continue;
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Shape one SUCCESSFUL tool result for the model. Returns the text unchanged when it is not JSON.
 * `tool` is the resolved MCP name.
 */
export function shapeForAgent(tool: string, args: Record<string, unknown>, text: string, ctx: AgentResultContext): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== 'object') return text;
  const shaped = tool === 'list_files' ? shapeFileListing(parsed, args ?? {}, ctx) : tool === 'get_file' ? shapeFile(parsed) : parsed;
  const compact = JSON.stringify(shaped);
  return compact.length < text.length ? compact : text;
}
