/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Resource grants enforced at run time — which datasets, knowledge, files, metrics,
 *             connections and plan items an agent's tool call may touch
 * USER STORY: As the owner of an agent system I granted two datasets and one folder I want every
 *             tool call the agents make checked against exactly that list BEFORE the tool runs,
 *             so a model that wanders onto another id gets a refusal it can read — not my data.
 * ARCHITECTURE:
 *   - ONE place. `checkGrantScope` is called once per call by the agent executor
 *     (`grantedToolExecutor`, `os-tools.ts`), after the tool-name gate and before dispatch.
 *     Nothing else decides resource access for an agent run.
 *   - DECLARATIVE. `TOOL_RESOURCES` says, per tool, which argument names which kind of resource
 *     and whether the call reads or writes it; which results are lists to filter; which
 *     argument is free-form SQL; and what a tool creates. `NO_GRANTED_RESOURCE` lists every
 *     other tool with the reason it touches none of the grant kinds. `grant-scope.test.ts`
 *     requires every registered MCP tool to be in exactly one of the two, so a NEW tool fails
 *     the suite until someone classifies it (the ratchet of `core/mcp/write-tool-meta.test.ts`).
 *   - NARROWS ONLY. The call still runs as the signed-in user through the same governed door;
 *     this check can refuse or filter, never add. The runner's own rights stay the outer bound.
 *   - PER KIND. A kind with at least one enabled grant is RESTRICTED to its granted ids (plus
 *     what this run created). A kind with no grant at all keeps the running user's own access —
 *     the behaviour every existing system had (see `kindScope`). An id granted `Off`/`Blocked`
 *     is refused either way. A `Read` grant refuses writes on that id.
 *   - Pure: no `server-only`. The two lookups that need a store (where a file lives, which
 *     physical tables a dataset has) are injected as {@link GrantResolvers}.
 */
import { isUnderFolder, normaliseFolderPath } from '@core/kernel/folders';
import type { ArtifactGrant, Capability, System } from '@tabs/agents/lib/system-schema';
import { sqlTableRefs } from '@tabs/agents/lib/build/sql-tables';

/** The kinds whose artifacts live in folders, so a NEW one can be confined to a granted folder. */
export type FolderKind = 'files' | 'data' | 'knowledge';

/** The governed resource kinds a system can be granted (`grants.*` minus `tools`). */
export type ResourceKind = 'data' | 'knowledge' | 'metrics' | 'connections' | 'files' | 'plan';
export const RESOURCE_KINDS: readonly ResourceKind[] = ['data', 'knowledge', 'metrics', 'connections', 'files', 'plan'];

/** What a call does to the resource it names. */
export type Access = 'read' | 'write';

/** How a kind is named to the model. */
const KIND_NOUN: Record<ResourceKind, string> = {
  data: 'dataset',
  knowledge: 'knowledge item',
  metrics: 'metric',
  connections: 'connection',
  files: 'file',
  plan: 'plan item',
};

/** An argument that names ONE existing resource by id. `arg` may be `a` or `a[].b`. */
type IdTarget = { kind: ResourceKind; arg: string; access: Access };

export type ToolResourceRule = {
  /** Arguments that each name an existing resource by its id. */
  ids?: IdTarget[];
  /** A `<kind>` + `<id>` argument pair (the polymorphic governance tools). */
  kindId?: { kindArg: string; idArg: string; access: Access };
  /** One argument shaped `"<kind>:<id>"`. */
  ref?: { arg: string; access: Access };
  /** The Operating Model `scope` argument (my | domain | company) → `manual:<scope>`. */
  planScope?: { arg: string; access: Access };
  /**
   * A folder argument a NEW artifact is written into. `kind` says which kind's folder grants
   * decide it (default `files`).
   */
  folderWrite?: { arg: string; kind?: FolderKind };
  /** Free-form SQL: every table it names must belong to a granted dataset. */
  sql?: { arg: string };
  /**
   * The result is a list: rows of another id are removed. `rowsKey` names the array (strict —
   * a row without an id is removed too); absent, every array of rows carrying `idPath` is filtered.
   */
  filter?: { kind: ResourceKind; idPath: string[]; rowsKey?: string };
  /** The call creates a NEW artifact of this kind; its id becomes usable for the rest of the run. */
  creates?: ResourceKind[];
  /** Acts across a whole kind with no id to check: refused while any of these kinds is restricted. */
  broad?: { kinds: ResourceKind[]; why: string };
};

const id = (kind: ResourceKind, arg: string, access: Access): IdTarget => ({ kind, arg, access });
const reads = (kind: ResourceKind, arg: string): ToolResourceRule => ({ ids: [id(kind, arg, 'read')] });
const writes = (kind: ResourceKind, arg: string): ToolResourceRule => ({ ids: [id(kind, arg, 'write')] });
const lists = (kind: ResourceKind): ToolResourceRule => ({ filter: { kind, idPath: ['id'] } });

/**
 * THE MAP: every tool that names, lists, searches or creates a grantable resource.
 * Keyed by MCP registry name (a legacy alias is resolved before the lookup).
 */
export const TOOL_RESOURCES: Readonly<Record<string, ToolResourceRule>> = {
  // ------------------------------------------------------------------ data --
  list_datasets: lists('data'),
  get_dataset: reads('data', 'datasetId'),
  profile_dataset: reads('data', 'datasetId'),
  get_sync_status: reads('data', 'datasetId'),
  propose_quality_fixes: reads('data', 'datasetId'),
  query_data: { sql: { arg: 'sql' } },
  add_dataset_version: writes('data', 'datasetId'),
  apply_quality_fixes: writes('data', 'datasetId'),
  define_quality_rules: writes('data', 'datasetId'),
  document_dataset: writes('data', 'datasetId'),
  ingest_dataset: writes('data', 'datasetId'),
  retire_dataset: writes('data', 'datasetId'),
  // Appends a run to the dataset's durable quality series — a state change on that dataset.
  run_quality_checks: writes('data', 'datasetId'),
  sync_dataset_now: writes('data', 'datasetId'),
  transform_silver: writes('data', 'datasetId'),
  build_gold_join: { ids: [id('data', 'datasetId', 'write'), id('data', 'picks[].datasetId', 'read')] },
  set_dataset_sync: { ids: [id('data', 'datasetId', 'write'), id('connections', 'connectionId', 'read')] },
  create_dataset: { folderWrite: { arg: 'folder', kind: 'data' }, creates: ['data'] },
  // Adopts a table an exposure set published to the runner's domain as a NEW dataset.
  adopt_exposed_table: { creates: ['data'] },
  reconcile_domain_tables: { broad: { kinds: ['data'], why: 'it reconciles every table of a domain' } },
  request_promotion: { kindId: { kindArg: 'kind', idArg: 'id', access: 'write' } },
  // --------------------------------------------------------------- metrics --
  list_metrics: lists('metrics'),
  get_metric: reads('metrics', 'metricId'),
  query_metric: reads('metrics', 'metricId'),
  promote_metric: writes('metrics', 'metricId'),
  // Adds a measure over a dataset the system must be able to read; the metric it defines is new.
  define_metric: { ids: [id('data', 'datasetId', 'read')], creates: ['metrics'] },
  preview_metric: reads('data', 'datasetId'),
  suggest_metrics: { broad: { kinds: ['data', 'metrics'], why: 'it reads every dataset and metric the running user can see' } },
  // ------------------------------------------------------------- knowledge --
  list_knowledge: lists('knowledge'),
  get_knowledge: reads('knowledge', 'workflowId'),
  search_knowledge: { filter: { kind: 'knowledge', rowsKey: 'hits', idPath: ['unit', 'provenance', 'workflowId'] } },
  index_knowledge: writes('knowledge', 'workflowId'),
  publish_knowledge: writes('knowledge', 'workflowId'),
  retire_knowledge: writes('knowledge', 'workflowId'),
  author_knowledge: { creates: ['knowledge'] },
  // A note is filed into a folder of My knowledge, so a writable knowledge folder confines it.
  // (`author_knowledge` creates a business process, which has no folder — nothing to confine.)
  save_knowledge_note: { folderWrite: { arg: 'folder', kind: 'knowledge' }, creates: ['knowledge'] },
  import_okf_bundle: { creates: ['knowledge'] },
  export_okf_bundle: { ids: [id('knowledge', 'workflowId', 'read')], creates: ['files'] },
  // ----------------------------------------------------------------- files --
  list_files: lists('files'),
  search_files: lists('files'),
  get_file: reads('files', 'fileId'),
  upload_file: { folderWrite: { arg: 'folder' }, creates: ['files'] },
  reindex_corpus: { broad: { kinds: ['files', 'knowledge'], why: 'it re-indexes a whole tenant corpus' } },
  // ----------------------------------------------------------- connections --
  list_connections: lists('connections'),
  get_connection: reads('connections', 'connId'),
  get_catalog_snapshot: reads('connections', 'connId'),
  get_catalog_classification: reads('connections', 'connId'),
  list_exposure_sets: reads('connections', 'connId'),
  // Writes the probe status back, but the builder provisions it with a READ grant — testing a
  // connection you may read is not a change to it.
  test_connection: reads('connections', 'connId'),
  classify_catalog: writes('connections', 'connId'),
  configure_connection: writes('connections', 'connId'),
  refresh_connection_catalog: writes('connections', 'connId'),
  retire_connection: writes('connections', 'connId'),
  promote_connection: writes('connections', 'connId'),
  create_exposure_set: writes('connections', 'connId'),
  create_connection: { creates: ['connections'] },
  // These name an EXPOSURE or an ADOPTION, which cannot be matched to a granted connection here.
  update_exposure_set: { broad: { kinds: ['connections'], why: 'it names an exposure set, which cannot be matched to a granted connection' } },
  revoke_exposure_set: { broad: { kinds: ['connections'], why: 'it names an exposure set, which cannot be matched to a granted connection' } },
  adopt_entity_actions: { broad: { kinds: ['connections'], why: 'it names an exposure set, which cannot be matched to a granted connection' } },
  revoke_action_adoption: { broad: { kinds: ['connections'], why: 'it names an action adoption, which cannot be matched to a granted connection' } },
  // ------------------------------------------------------------------ plan --
  get_operating_manual: { planScope: { arg: 'scope', access: 'read' } },
  list_operating_manual_versions: { planScope: { arg: 'scope', access: 'read' } },
  update_operating_manual: { planScope: { arg: 'scope', access: 'write' } },
  restore_operating_manual_version: { planScope: { arg: 'scope', access: 'write' } },
  // ------------------------------------ governance tools over "<kind>, <id>" --
  get_history: { kindId: { kindArg: 'kind', idArg: 'id', access: 'read' } },
  get_version: { kindId: { kindArg: 'kind', idArg: 'id', access: 'read' } },
  diff_versions: { kindId: { kindArg: 'kind', idArg: 'id', access: 'read' } },
  get_engineering_view: { kindId: { kindArg: 'kind', idArg: 'id', access: 'read' } },
  go_live: { kindId: { kindArg: 'kind', idArg: 'id', access: 'write' } },
  retire: { kindId: { kindArg: 'kind', idArg: 'id', access: 'write' } },
  request_certification: { kindId: { kindArg: 'kind', idArg: 'id', access: 'write' } },
  // The ROOT of the graph is checked; other nodes are names and edges, never content.
  get_lineage: { ref: { arg: 'ref', access: 'read' } },
  // --------------------------------------- apps consuming a resource by ref --
  use_data: reads('data', 'ref'),
  use_connection: reads('connections', 'ref'),
  use_knowledge: reads('knowledge', 'ref'),
  use_as_data: { creates: ['data'] },
};

const APPS = 'acts on an app; apps are not a grant kind (the running user\'s own access applies)';
const DASHBOARDS = 'acts on a dashboard; dashboards are not a grant kind, and a chart reads its data later as each viewer';
const AGENT_SYSTEMS = 'acts on an agent system or one of its runs; agent systems are not a grant kind';
const GOVERNANCE = 'reads or decides a governance record (an approval, a policy, a cost view), not a granted resource';
const META = 'describes the caller or the OS itself; names no resource';
const MONITORING = 'reads run and trace telemetry, not a granted resource';

/**
 * Every OTHER tool, with the reason it touches none of the grant kinds. A tool belongs here only
 * after its arguments were read: none of them names a dataset, knowledge item, metric,
 * connection, file or plan item.
 */
export const NO_GRANTED_RESOURCE: Readonly<Record<string, string>> = {
  // agents
  build_agent_system: AGENT_SYSTEMS, commit_agent_files: AGENT_SYSTEMS, create_agent_system: AGENT_SYSTEMS,
  get_agent_run: AGENT_SYSTEMS, get_agent_system: AGENT_SYSTEMS, list_agent_systems: AGENT_SYSTEMS,
  resume_agent_run: AGENT_SYSTEMS, run_agent_system: AGENT_SYSTEMS,
  // software
  archive: APPS, build_software: APPS, commit: APPS, create_software: APPS, decide_deploy: APPS, delete: APPS,
  design_software: APPS, generate_app_spec: APPS, get_app_spec: APPS, get_software: APPS, get_software_status: APPS,
  list_software: APPS, promote: APPS, push_app_files: APPS, read_app_files: APPS, request_deploy: APPS,
  set_app_design: APPS, set_app_spec: APPS, start_preview: APPS, verify_software: APPS,
  // dashboards
  create_dashboard: DASHBOARDS, get_dashboard: DASHBOARDS, list_dashboards: DASHBOARDS,
  // governance
  approve_promotion: GOVERNANCE, decide_approval: GOVERNANCE, get_request: GOVERNANCE, list_approvals: GOVERNANCE,
  get_cost: GOVERNANCE, get_policy_view: GOVERNANCE,
  // meta
  whoami: META, list_capabilities: META, get_guide: META,
  // monitoring / orchestration telemetry
  get_monitoring_overview: MONITORING, get_run_trace: MONITORING, list_runs: MONITORING, get_dagster_run: MONITORING,
  // connections
  list_connection_templates: 'lists the connection templates the OS ships; names no connection',
  list_exposed_tables: 'lists the tables exposure sets published to the running user\'s domains; an exposure is not a grant kind, and adopting one creates a NEW dataset',
  list_adoptable_actions: 'lists the actions exposure sets published to the running user\'s domains; an exposure is not a grant kind',
};

/** `kind` words the polymorphic tools accept, mapped to the grant kind they name (others → none). */
const KIND_WORD: Readonly<Record<string, ResourceKind>> = {
  dataset: 'data',
  data: 'data',
  knowledge: 'knowledge',
  workflow: 'knowledge',
  personal_knowledge: 'knowledge',
  metric: 'metrics',
  connection: 'connections',
  file: 'files',
};

// ------------------------------------------------------------------ scope --

/** A FILES folder grant that is switched on. */
export type FolderScope = { path: string; scope: 'personal' | 'domain'; write: boolean };

export type KindScope = {
  /** At least one enabled grant exists for this kind → only `read`/`write` ids (and created ones). */
  restricted: boolean;
  /** Ids the system may read. */
  read: ReadonlySet<string>;
  /** Ids the system may also change. */
  write: ReadonlySet<string>;
  /** Ids granted `Off` / `Blocked` — refused even when the kind is otherwise unrestricted. */
  denied: ReadonlySet<string>;
};

export type GrantScope = {
  kinds: Record<ResourceKind, KindScope>;
  /** Enabled FILES folder grants (files are granted by folder, resolved live). */
  folders: FolderScope[];
  /**
   * Enabled DATA and KNOWLEDGE folder grants. Their items are already expanded to ids upstream
   * (which is what READS are checked against); the folders themselves are kept for one thing —
   * deciding where a NEW dataset or note may be filed.
   */
  createFolders: Record<Exclude<FolderKind, 'files'>, FolderScope[]>;
  /** Ids this RUN created, per kind — usable for the rest of the run, by every agent of the team. */
  created: Record<ResourceKind, Set<string>>;
};

const enabled = (c: Capability): boolean => c === 'Read' || c === 'Write-approval' || c === 'Write-bounded';
const canWrite = (c: Capability): boolean => c === 'Write-approval' || c === 'Write-bounded';

/**
 * How ONE kind's grant list is read.
 *
 * THE EMPTY-GRANTS DECISION (compatibility): a kind with NO enabled grant is NOT restricted —
 * its tools keep the running user's own access, which is what every system did before grants
 * were enforced (a new system is one agent with `search_knowledge` and no knowledge grant; a
 * strict reading would have made it find nothing overnight). Declaring ONE grant for a kind is
 * what restricts that kind. The prompt says which kinds are restricted and which are not.
 */
function kindScope(grants: ArtifactGrant[]): KindScope {
  const read = new Set<string>();
  const write = new Set<string>();
  const denied = new Set<string>();
  let restricted = false;
  for (const g of grants) {
    if (!enabled(g.capability)) {
      if (g.id) denied.add(g.id);
      continue;
    }
    restricted = true; // an enabled FOLDER grant restricts the kind even when it resolved to no item
    if (!g.id) continue;
    read.add(g.id);
    if (canWrite(g.capability)) write.add(g.id);
  }
  // An id both granted and switched off stays granted (the explicit grant wins over a stale Off row).
  for (const d of [...denied]) if (read.has(d)) denied.delete(d);
  return { restricted, read, write, denied };
}

/**
 * The scope a system's grants give its agents. `sys` is the RUN's system: folder grants for data
 * and knowledge are already expanded to item ids upstream (`resolveFolderGrantsForRun`); files
 * folder grants stay folders and are resolved live per call.
 */
export function grantScopeOf(sys: System, createdSeed?: Partial<Record<ResourceKind, string[]>>): GrantScope {
  const g = sys.grants;
  const kinds = {
    data: kindScope(g.data),
    knowledge: kindScope(g.knowledge),
    metrics: kindScope(g.metrics),
    connections: kindScope(g.connections),
    files: kindScope(g.files),
    plan: kindScope(g.plan),
  };
  const folders: FolderScope[] = g.files
    .filter((f) => f.folder && enabled(f.capability))
    .map((f) => ({ path: normaliseFolderPath(f.folder!.path), scope: f.folder!.scope, write: canWrite(f.capability) }));
  const foldersOf = (list: ArtifactGrant[]): FolderScope[] =>
    list
      .filter((f) => f.folder && enabled(f.capability))
      .map((f) => ({ path: normaliseFolderPath(f.folder!.path), scope: f.folder!.scope, write: canWrite(f.capability) }));
  const created = { data: new Set<string>(), knowledge: new Set<string>(), metrics: new Set<string>(), connections: new Set<string>(), files: new Set<string>(), plan: new Set<string>() };
  for (const k of RESOURCE_KINDS) for (const v of createdSeed?.[k] ?? []) created[k].add(v);
  return { kinds, folders, createFolders: { data: foldersOf(g.data), knowledge: foldersOf(g.knowledge) }, created };
}

/** Where one file the running user can see lives. */
export type FileLocation = { id: string; folder: string; lane: 'personal' | 'domain' | 'company' };

/** The two lookups that need a store. Both run AS THE RUNNING USER — they can only narrow. */
export type GrantResolvers = {
  /** Every file the running user can see, with its folder and lane. */
  fileLocations: () => Promise<FileLocation[]>;
  /** The physical table names (fully qualified, any layer) a dataset the running user can see resolves to. */
  datasetTables: (datasetId: string) => Promise<string[]>;
};

// ---------------------------------------------------------------- verdict --

export type GrantRefusal = { code: 'forbidden'; reason: string; kind?: ResourceKind; id?: string };

export type GrantVerdict =
  | { allow: false; refusal: GrantRefusal }
  | {
      allow: true;
      /** Narrow a successful result to the granted rows; returns a refusal when it cannot be narrowed. */
      shape?: (text: string) => { text: string } | { refusal: GrantRefusal };
      /** Record what a successful call created (call with the tool's RAW result text). */
      created?: (text: string) => void;
    };

const refuse = (reason: string, kind?: ResourceKind, rid?: string): { allow: false; refusal: GrantRefusal } => ({
  allow: false,
  refusal: { code: 'forbidden', reason, ...(kind ? { kind } : {}), ...(rid ? { id: rid } : {}) },
});

/** Up to twelve ids, for a message the model can act on. */
function sample(ids: Iterable<string>): string {
  const list = [...ids];
  if (list.length === 0) return 'none';
  return list.length > 12 ? `${list.slice(0, 12).join(', ')} … (${list.length} in all)` : list.join(', ');
}

/** Read `a` or `a[].b` out of the arguments, as the list of string ids it names. */
function argIds(args: Record<string, unknown>, path: string): string[] {
  const [head, tail] = path.split('[].');
  const v = args[head];
  if (tail === undefined) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const row of v) {
    const inner = row && typeof row === 'object' ? (row as Record<string, unknown>)[tail] : undefined;
    if (typeof inner === 'string' && inner.trim()) out.push(inner.trim());
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function at(row: unknown, path: string[]): unknown {
  let cur: unknown = row;
  for (const p of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** The files a system's folder grants cover, from the running user's live listing. */
function filesIn(folders: FolderScope[], locations: FileLocation[], needWrite: boolean): Set<string> {
  const out = new Set<string>();
  for (const f of locations) {
    if (folders.some((g) => (!needWrite || g.write) && g.scope === f.lane && isUnderFolder(g.path, f.folder))) out.add(f.id);
  }
  return out;
}

const FOLDER_NOUN: Record<FolderKind, { one: string; many: string; lane: string }> = {
  files: { one: 'a file', many: 'files', lane: 'files' },
  data: { one: 'a dataset', many: 'datasets', lane: 'data' },
  knowledge: { one: 'a knowledge note', many: 'knowledge notes', lane: 'knowledge' },
};

const describeFolder = (f: FolderScope, kind: FolderKind = 'files'): string =>
  `${f.path} (${f.scope === 'personal' ? 'My' : 'Domain'} ${FOLDER_NOUN[kind].lane}${f.write ? '' : ', read-only'})`;

/**
 * THE CHECK — one tool call against the system's grants, before the tool runs.
 *
 * Returns a refusal (typed `forbidden`, with the kind and id) or an allowance that may carry a
 * result filter and a created-id recorder. An UNCLASSIFIED tool is refused: the registry test
 * keeps that from happening for a registered tool, and a tool that slipped past it must not run
 * unchecked.
 */
export async function checkGrantScope(
  tool: string,
  args: Record<string, unknown> | undefined,
  scope: GrantScope,
  resolvers: GrantResolvers,
): Promise<GrantVerdict> {
  const rule = TOOL_RESOURCES[tool];
  if (!rule) {
    if (Object.prototype.hasOwnProperty.call(NO_GRANTED_RESOURCE, tool)) return { allow: true };
    return refuse(`${tool} has not been classified for resource grants, so an agent may not call it — this is a platform gap to report, not something to retry`);
  }
  const a = args ?? {};
  let fileIndex: FileLocation[] | null = null;
  const files = async (): Promise<FileLocation[]> => (fileIndex ??= await resolvers.fileLocations());

  /** May this run touch `rid` of `kind` in this way? Returns the refusal reason, or null. */
  const denyReason = async (kind: ResourceKind, rid: string, access: Access): Promise<string | null> => {
    const noun = KIND_NOUN[kind];
    if (scope.created[kind].has(rid)) return null; // this run made it
    const ks = scope.kinds[kind];
    if (ks.denied.has(rid)) return `This agent is not granted ${noun} ${rid} — it is switched off in this system's grants.`;
    if (kind === 'files') {
      if (scope.folders.length === 0 && !ks.restricted) return null;
      if (ks.read.has(rid) && (access === 'read' || ks.write.has(rid))) return null;
      const index = await files();
      if (filesIn(scope.folders, index, access === 'write').has(rid)) return null;
      if (access === 'write' && filesIn(scope.folders, index, false).has(rid)) {
        return `This agent is granted file ${rid} read-only — it may not change it.`;
      }
      return `This agent is not granted file ${rid}. It may use files in: ${scope.folders.map((f) => describeFolder(f)).join(', ') || 'no folder'} — list them with list_files.`;
    }
    if (!ks.restricted) {
      // A metric follows its dataset: with no metric grant of its own, a metric is in scope only
      // when its dataset is — otherwise a dataset restriction could be walked around through the
      // semantic layer. (A metric id is `<datasetId>.<measure>`.)
      if (kind === 'metrics') {
        const data = scope.kinds.data;
        if (data.restricted) {
          const inScope = [...data.read, ...scope.created.data].some((d) => rid.startsWith(`${d}.`));
          if (!inScope) return `This agent is not granted metric ${rid}: its dataset is not one of the datasets this system is granted (${sample(data.read)}).`;
          if (access === 'write' && ![...data.write, ...scope.created.data].some((d) => rid.startsWith(`${d}.`))) {
            return `This agent is granted the dataset of metric ${rid} read-only — it may not change the metric.`;
          }
        }
      }
      return null;
    }
    if (!ks.read.has(rid)) return `This agent is not granted ${noun} ${rid}. It may use: ${sample(ks.read)}.`;
    if (access === 'write' && !ks.write.has(rid)) return `This agent is granted ${noun} ${rid} read-only — it may not change it.`;
    return null;
  };

  for (const t of rule.ids ?? []) {
    for (const rid of argIds(a, t.arg)) {
      const why = await denyReason(t.kind, rid, t.access);
      if (why) return refuse(why, t.kind, rid);
    }
  }

  if (rule.kindId) {
    const word = typeof a[rule.kindId.kindArg] === 'string' ? (a[rule.kindId.kindArg] as string).trim().toLowerCase() : '';
    const kind = KIND_WORD[word];
    const [rid] = argIds(a, rule.kindId.idArg);
    if (kind && rid) {
      const why = await denyReason(kind, rid, rule.kindId.access);
      if (why) return refuse(why, kind, rid);
    }
  }

  if (rule.ref) {
    const raw = typeof a[rule.ref.arg] === 'string' ? (a[rule.ref.arg] as string).trim() : '';
    const cut = raw.indexOf(':');
    const kind = cut > 0 ? KIND_WORD[raw.slice(0, cut).toLowerCase()] : undefined;
    const rid = cut > 0 ? raw.slice(cut + 1).trim() : '';
    if (kind && rid) {
      const why = await denyReason(kind, rid, rule.ref.access);
      if (why) return refuse(why, kind, rid);
    }
  }

  if (rule.planScope) {
    const s = typeof a[rule.planScope.arg] === 'string' ? (a[rule.planScope.arg] as string).trim().toLowerCase() : '';
    if (s) {
      const rid = `manual:${s}`;
      const why = await denyReason('plan', rid, rule.planScope.access);
      if (why) return refuse(why, 'plan', rid);
    }
  }

  if (rule.broad) {
    const hit = rule.broad.kinds.filter((k) => scope.kinds[k].restricted);
    if (hit.length > 0) {
      return refuse(
        `${tool} is not available to this agent: ${rule.broad.why}, and this system's ${hit.map((k) => KIND_NOUN[k]).join(' and ')} grants limit it to specific items.`,
        hit[0],
      );
    }
  }

  if (rule.folderWrite) {
    const fk: FolderKind = rule.folderWrite.kind ?? 'files';
    const kindFolders = fk === 'files' ? scope.folders : scope.createFolders[fk];
    if (kindFolders.length > 0) {
      const noun = FOLDER_NOUN[fk];
      const describe = (f: FolderScope) => describeFolder(f, fk);
      // A NEW artifact is the runner's own (My …). It is refused only where a grant says read-only:
      // inside a granted folder that no write-capable grant covers.
      const raw = a[rule.folderWrite.arg];
      const target = normaliseFolderPath(typeof raw === 'string' ? raw : '');
      const writable = kindFolders.filter((f) => f.write);
      const covering = kindFolders.filter((f) => f.scope === 'personal' && isUnderFolder(f.path, target));
      if (covering.length > 0 && !covering.some((f) => f.write)) {
        return refuse(
          `This agent is granted the folder ${target} read-only — it may not write ${noun.one} there.` +
            (writable.length > 0 ? ` It may write to: ${writable.map(describe).join(', ')}.` : ' This system has no writable folder grant.'),
          fk,
        );
      }
      // WHERE A TARGET WAS CHOSEN, THAT IS WHERE NEW ARTIFACTS GO. A system with a writable folder
      // (a declared output, or a folder granted Read + write) may create inside one of them and
      // nowhere else: choosing the target is the permission, and it is not a permission for the
      // rest of the runner's drive. The new artifact lands in the runner's My lane at that path —
      // also for a Domain target, whose sharing is the separate, held promotion — so the path
      // decides. The same rule for a file, a dataset and a knowledge note.
      if (writable.length > 0 && !writable.some((f) => isUnderFolder(f.path, target))) {
        return refuse(
          `This agent may not write ${noun.one} to ${target}: this system writes ${noun.many} only to ${writable.map(describe).join(', ')}. Pass one of those as \`folder\`.`,
          fk,
        );
      }
    }
  }

  if (rule.sql && scope.kinds.data.restricted) {
    const refs = sqlTableRefs(typeof a[rule.sql.arg] === 'string' ? (a[rule.sql.arg] as string) : '');
    const ids = [...new Set([...scope.kinds.data.read, ...scope.created.data])];
    const allowed = new Map<string, string>();
    // A table name is compared in the form the statement reader produces (lower-cased, quotes
    // dropped), so `"iceberg"."Sales"."gold_orders"` and iceberg.sales.gold_orders are one table.
    const canonical = (fqn: string): string => {
      const r = sqlTableRefs(`select 1 from ${fqn}`);
      return r.ok && r.tables.length === 1 ? r.tables[0] : fqn.toLowerCase();
    };
    for (const d of ids) for (const t of await resolvers.datasetTables(d)) allowed.set(canonical(t), d);
    const names = allowed.size > 0 ? [...allowed.keys()].join(', ') : 'none (no granted dataset is built yet)';
    if (!refs.ok) {
      return refuse(
        `${tool} was not run: this system's data grants limit it to specific datasets, and the statement cannot be checked against them because ${refs.reason}. Write one SELECT over the granted tables by their full names: ${names}.`,
        'data',
      );
    }
    const outside = refs.tables.filter((t) => !allowed.has(t));
    if (outside.length > 0) {
      return refuse(
        `This agent is not granted the table${outside.length === 1 ? '' : 's'} ${outside.join(', ')}. Its data grants cover these tables only, by their full catalog.schema.table name (get_dataset → queryable): ${names}.`,
        'data',
      );
    }
  }

  const verdict: Extract<GrantVerdict, { allow: true }> = { allow: true };

  const filter = rule.filter;
  if (filter) {
    const ks = scope.kinds[filter.kind];
    // A metric follows its dataset (see `denyReason`): a dataset restriction narrows the metric list too.
    const metricsFollowData = filter.kind === 'metrics' && !ks.restricted && scope.kinds.data.restricted;
    const active = filter.kind === 'files' ? scope.folders.length > 0 || ks.restricted : ks.restricted || ks.denied.size > 0 || metricsFollowData;
    if (active) {
      const keepFiles = filter.kind === 'files' ? new Set([...filesIn(scope.folders, await files(), false), ...ks.read]) : null;
      const keep = (rid: unknown): boolean => {
        // A row that names no item: removed under a restriction (it cannot be shown to be granted),
        // kept when the only thing in force is a list of switched-off ids.
        if (typeof rid !== 'string' || !rid) return !(ks.restricted || keepFiles !== null || metricsFollowData);
        if (scope.created[filter.kind].has(rid)) return true;
        if (ks.denied.has(rid)) return false;
        if (keepFiles) return keepFiles.has(rid);
        if (metricsFollowData) return [...scope.kinds.data.read, ...scope.created.data].some((d) => rid.startsWith(`${d}.`));
        return ks.restricted ? ks.read.has(rid) : true;
      };
      const noun = KIND_NOUN[filter.kind];
      verdict.shape = (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { refusal: { code: 'forbidden', reason: `${tool} returned something that could not be limited to the ${noun}s this system is granted, so it was withheld.`, kind: filter.kind } };
        }
        let removed = 0;
        const prune = (rows: unknown[], strict: boolean): unknown[] =>
          rows.filter((row) => {
            const rid = at(row, filter.idPath);
            if (!strict && rid === undefined) return true;
            const ok = keep(rid);
            if (!ok) removed += 1;
            return ok;
          });
        const hasIds = (rows: unknown[]): boolean => rows.some((r) => typeof at(r, filter.idPath) === 'string');
        const walk = (v: unknown, depth: number): unknown => {
          if (Array.isArray(v)) return hasIds(v) ? prune(v, true) : v;
          if (!isRecord(v) || depth >= 3) return v;
          const out: Record<string, unknown> = {};
          for (const [k, child] of Object.entries(v)) out[k] = walk(child, depth + 1);
          return out;
        };
        let shaped: unknown;
        if (filter.rowsKey) {
          if (!isRecord(parsed) || !Array.isArray(parsed[filter.rowsKey])) return { text };
          shaped = { ...parsed, [filter.rowsKey]: prune(parsed[filter.rowsKey] as unknown[], true) };
        } else {
          shaped = walk(parsed, 0);
        }
        if (removed === 0) return { text };
        const note = `Limited to the ${noun}s this system is granted: ${removed} other ${removed === 1 ? 'item' : 'items'} the running user can see ${removed === 1 ? 'was' : 'were'} left out.`;
        return { text: JSON.stringify(Array.isArray(shaped) ? { grantScope: note, items: shaped } : { grantScope: note, ...(shaped as Record<string, unknown>) }) };
      };
    }
  }

  if (rule.creates && rule.creates.length > 0) {
    const kinds = rule.creates;
    verdict.created = (text) => {
      for (const kind of kinds) for (const rid of createdIds(kind, text)) scope.created[kind].add(rid);
    };
  }
  return verdict;
}

/** Result keys that carry the id (or the record) of a newly created artifact, per kind. */
const CREATED_KEYS: Record<ResourceKind, string[]> = {
  data: ['dataset', 'datasets', 'datasetId'],
  knowledge: ['workflow', 'workflows', 'workflowId', 'knowledge'],
  metrics: ['metric', 'metrics', 'metricId'],
  connections: ['connection', 'connections', 'connId', 'connectionId'],
  files: ['file', 'files', 'fileId', 'asset'],
  plan: [],
};

/**
 * The ids a creating tool's result names: the record's own `id`, or the id under the kind's own
 * key (`dataset: {id}`, `datasetId`, `workflows: [{id}]`). A tool that creates two kinds names
 * each under its own key; the bare top-level `id` belongs to the FIRST kind the rule lists.
 */
export function createdIds(kind: ResourceKind, resultText: string, primary = true): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const out = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
    else if (isRecord(v) && typeof v.id === 'string' && v.id.trim()) out.add(v.id.trim());
    else if (Array.isArray(v)) for (const row of v) take(row);
  };
  if (primary && typeof parsed.id === 'string') take(parsed.id);
  for (const key of CREATED_KEYS[kind]) take(parsed[key]);
  // define_metric answers `{ datasetId, measure: { name } }`; the metric's id is `<datasetId>.<measure>`.
  if (kind === 'metrics' && typeof parsed.datasetId === 'string' && isRecord(parsed.measure) && typeof parsed.measure.name === 'string') {
    out.add(`${parsed.datasetId}.${parsed.measure.name}`);
  }
  return [...out];
}

/** The ids a finished run's recorded steps created — how a RESUMED run gets its ledger back. */
export function createdFromSteps(steps: { tool: string; result: string; isError: boolean }[], resolve: (tool: string) => string = (t) => t): Partial<Record<ResourceKind, string[]>> {
  const out: Partial<Record<ResourceKind, string[]>> = {};
  for (const s of steps) {
    if (s.isError) continue;
    const rule = TOOL_RESOURCES[resolve(s.tool)];
    for (const kind of rule?.creates ?? []) {
      const ids = createdIds(kind, s.result);
      if (ids.length > 0) out[kind] = [...(out[kind] ?? []), ...ids];
    }
  }
  return out;
}

// ----------------------------------------------------------------- prompt --

const LABEL: Record<ResourceKind, string> = {
  data: 'datasets',
  knowledge: 'knowledge',
  metrics: 'metrics',
  connections: 'connections',
  files: 'files',
  plan: 'plan (operating model)',
};

/**
 * What the prompt tells the model about its resource grants — and it says only what the engine
 * enforces. Empty when the system declares no resource grant at all.
 */
export function grantScopeBrief(sys: System): string {
  const scope = grantScopeOf(sys);
  const rows: string[] = [];
  const open: string[] = [];
  for (const kind of RESOURCE_KINDS) {
    const ks = scope.kinds[kind];
    if (kind === 'files') {
      const fileIds = [...ks.read].map((rid) => (ks.write.has(rid) ? rid : `${rid} (read-only)`));
      if (scope.folders.length > 0) {
        rows.push(`- files: only files in ${scope.folders.map((f) => describeFolder(f)).join(', ')}${fileIds.length > 0 ? `, and the files ${fileIds.join(', ')}` : ''} — list_files returns exactly these files; read each with get_file`);
      } else if (fileIds.length > 0) {
        rows.push(`- files: only the files ${fileIds.join(', ')} — read each with get_file`);
      } else if (!ks.restricted) open.push(LABEL[kind]);
      continue;
    }
    if (!ks.restricted) {
      open.push(LABEL[kind]);
      continue;
    }
    const ids = [...ks.read].map((rid) => (ks.write.has(rid) ? rid : `${rid} (read-only)`));
    rows.push(`- ${LABEL[kind]}: ${ids.length > 0 ? ids.join(', ') : 'none (the granted folder holds no item yet)'}`);
  }
  if (rows.length === 0) return '';
  const lines = [
    'This system is granted the resources below, and the engine ENFORCES it: a tool call that names',
    'another id of that kind is refused before it runs (a typed `forbidden` result), a list or',
    'search returns only the granted items, and query_data runs only over the granted datasets\'',
    'tables. An id marked read-only refuses changes. Anything this run creates is usable afterwards.',
    '',
    ...rows,
  ];
  if (open.length > 0) {
    lines.push('', `No grant narrows these kinds, so the running user's own access applies to them: ${open.join(', ')}.`);
  }
  return lines.join('\n');
}
