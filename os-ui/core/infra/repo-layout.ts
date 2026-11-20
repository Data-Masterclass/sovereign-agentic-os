/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Repo layout — the ONE place every repository name and every path inside an OS
 *             repository is defined (component design 12, "Git layout", rule 4).
 * USER STORY: As an engineer who clones an OS repository I want the same readable folders in every
 *             repo (`data/dbt/`, `data/dagster/`, `agents/<system>/`, `dashboards/<slug>/`, `os/` …),
 *             and as an OS developer I want to import a path instead of spelling it, so that a
 *             layout change is one edit here and not a hunt through every reader and writer.
 * ARCHITECTURE:
 *   - PURE: constants and string functions only. No fs, no git, no env read at call time except
 *     the one documented config value for the dbt project directory (`OS_DBT_PROJECT_DIR`,
 *     default `data/dbt`), which the chart passes to os-ui AND to the Dagster image so both agree.
 *   - THREE REPO KINDS, one access boundary each (git cannot hide part of a repo):
 *       `user-<token>`    My scope — readable by that person and admins only;
 *       `domain-<domain>` one per domain — readable by its members;
 *       `platform`        platform-wide configuration — admins only.
 *     `<token>` is the opaque `sha256(<principal id>)` 12-hex prefix the agents generator already
 *     uses for a personal lane: principal ids are often e-mail addresses, and a repository name
 *     travels to mirrors, clone URLs and listings.
 *   - BACKWARD COMPATIBLE: a domain repo created before this layout is `<domain>.git`. Its name
 *     keeps resolving (the legacy ALIAS) until the layout migration renames it and leaves the old
 *     name as a symlink alias. A domain whose name would read as another kind (`user-…`,
 *     `domain-…`, `platform`) gets no alias — only its canonical name.
 *   - TWO LAYOUT VERSIONS: v1 is the historical tree (the dbt project at the repo root); v2 is the
 *     component-design-12 tree, marked by `os/layout.yml`. Readers ask `dbtProjectDir(layout)`
 *     instead of assuming the root, so a repo reads correctly before and after its migration.
 */
import { createHash } from 'node:crypto';

// ------------------------------------------------------------------ repos ---

export const DOMAIN_REPO_PREFIX = 'domain-';
export const USER_REPO_PREFIX = 'user-';
export const PLATFORM_REPO = 'platform';

/** A bare repository's directory suffix under `OS_REPOS_DIR`. */
export const REPO_SUFFIX = '.git';

/** A safe single path segment for a repository name: what git-http / git-daemon URLs accept. */
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RepoKind = 'domain' | 'user' | 'platform';

export type RepoRef =
  | { kind: 'domain'; domain: string }
  | { kind: 'user'; uid: string }
  | { kind: 'platform' };

/** A parsed repository NAME (the URL segment before `.git`). A user repo carries its token only. */
export type ParsedRepoName =
  | { kind: 'domain'; domain: string; legacy: boolean }
  | { kind: 'user'; token: string }
  | { kind: 'platform' };

/** The opaque, stable token that stands for a principal in a repository name or path. */
export function principalToken(uid: string): string {
  return createHash('sha256').update(String(uid ?? '')).digest('hex').slice(0, 12);
}

export function isSafeRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name) && !name.includes('..');
}

/** True when a bare name would read as a non-domain repo kind, so it cannot be a legacy alias. */
export function isReservedRepoName(name: string): boolean {
  return name === PLATFORM_REPO || name.startsWith(USER_REPO_PREFIX) || name.startsWith(DOMAIN_REPO_PREFIX);
}

/** `domain-<domain>`. Throws on a name that is not a safe path segment. */
export function domainRepoName(domain: string): string {
  const name = `${DOMAIN_REPO_PREFIX}${domain}`;
  if (!isSafeRepoName(domain) || !isSafeRepoName(name)) throw new Error(`invalid domain name for a repository: '${domain}'`);
  return name;
}

/** `user-<token>` — the My-scope repository of one principal. */
export function userRepoName(uid: string): string {
  if (!String(uid ?? '').trim()) throw new Error('a user repository needs a principal id');
  return `${USER_REPO_PREFIX}${principalToken(uid)}`;
}

/** The name a domain repo had before this layout (`<domain>`), or null when it cannot alias. */
export function legacyDomainRepoName(domain: string): string | null {
  return isSafeRepoName(domain) && !isReservedRepoName(domain) ? domain : null;
}

export function repoName(ref: RepoRef): string {
  if (ref.kind === 'domain') return domainRepoName(ref.domain);
  if (ref.kind === 'user') return userRepoName(ref.uid);
  return PLATFORM_REPO;
}

/** The URL path segment / directory name of a repository: `<name>.git`. */
export function repoDirName(name: string): string {
  if (!isSafeRepoName(name)) throw new Error(`invalid repository name '${name}'`);
  return `${name}${REPO_SUFFIX}`;
}

/** Read a repository name. A bare name that is not a reserved kind is a LEGACY domain alias. */
export function parseRepoName(name: string): ParsedRepoName | null {
  if (!isSafeRepoName(name)) return null;
  if (name === PLATFORM_REPO) return { kind: 'platform' };
  if (name.startsWith(USER_REPO_PREFIX)) {
    const token = name.slice(USER_REPO_PREFIX.length);
    return /^[0-9a-f]{12}$/.test(token) ? { kind: 'user', token } : null;
  }
  if (name.startsWith(DOMAIN_REPO_PREFIX)) {
    const domain = name.slice(DOMAIN_REPO_PREFIX.length);
    return isSafeRepoName(domain) ? { kind: 'domain', domain, legacy: false } : null;
  }
  return { kind: 'domain', domain: name, legacy: true };
}

/** Who may READ a repository — the repo boundary IS the access boundary (design 12). */
export function mayReadRepo(
  name: string,
  principal: { id: string; role: string; domains: readonly string[] },
): boolean {
  const parsed = parseRepoName(name);
  if (!parsed) return false;
  if (principal.role === 'admin') return true;
  if (parsed.kind === 'platform') return false;
  if (parsed.kind === 'user') return principalToken(principal.id) === parsed.token;
  return principal.domains.includes(parsed.domain);
}

// ------------------------------------------------------------- top level ---

export const ROOT_README = 'README.md';
export const README = 'README.md';

/** `data/` — data products: the dbt project and the Dagster definitions. */
export const DATA_DIR = 'data';
/** `data/dagster/` — Dagster definitions, schedules, sensors, dlt sources (WP-49). */
export const DAGSTER_DIR = `${DATA_DIR}/dagster`;
export const DAGSTER_DEFINITIONS_PATH = `${DAGSTER_DIR}/definitions.py`;
/** `dashboards/<slug>/` — saved queries + Vega-Lite specs (WP-52). */
export const DASHBOARDS_DIR = 'dashboards';
/** `knowledge/` — the OKF v0.3 bundle (WP-50, WP-44). */
export const KNOWLEDGE_DIR = 'knowledge';
/** `agents/<system>/` — graph.mjs, run.mjs, prompts/, evals/, README.md (WP-53). */
export const AGENTS_DIR = 'agents';
/** `apps/<slug>/` — source, Dockerfile, k8s/ (WP-54). */
export const APPS_DIR = 'apps';
/** `connections/<name>/` — catalog.properties for Trino (WP-50). */
export const CONNECTIONS_DIR = 'connections';
/** `os/` — the OS layer only: owners, scope, approvals, MCP and UI descriptions, pins. */
export const OS_DIR = 'os';

/** The default dbt project directory of a v2 repository; overridable by `OS_DBT_PROJECT_DIR`. */
export const DEFAULT_DBT_PROJECT_DIR = `${DATA_DIR}/dbt`;

/** The configured dbt project directory (v2). The ONE config value both os-ui and Dagster read. */
export function configuredDbtProjectDir(): string {
  const raw = (process.env.OS_DBT_PROJECT_DIR ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return DEFAULT_DBT_PROJECT_DIR;
  if (raw.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`OS_DBT_PROJECT_DIR '${raw}' is not a repo-relative directory`);
  }
  return raw;
}

/** Every top-level folder of the v2 layout, in README order. */
export const TOP_LEVEL_DIRS = [DATA_DIR, DASHBOARDS_DIR, KNOWLEDGE_DIR, AGENTS_DIR, APPS_DIR, CONNECTIONS_DIR, OS_DIR] as const;
export type TopLevelDir = (typeof TOP_LEVEL_DIRS)[number];

/** `<dir>/` — the subtree-ownership prefix form the git store reserves. */
export function prefixOf(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

// --------------------------------------------------------------- objects ---

function seg(s: string, what: string): string {
  const v = String(s ?? '');
  if (!v || v.includes('/') || v === '.' || v === '..') throw new Error(`invalid ${what} path segment '${v}'`);
  return v;
}

export function agentSystemDir(system: string): string {
  return `${AGENTS_DIR}/${seg(system, 'agent system')}`;
}
export function agentGraphPath(system: string): string {
  return `${agentSystemDir(system)}/graph.mjs`;
}
export function agentRunPath(system: string): string {
  return `${agentSystemDir(system)}/run.mjs`;
}
export const AGENTS_INDEX_PATH = `${AGENTS_DIR}/index.yml`;

/** LEGACY (v1 domain repos): the personal agent lane `agents/personal/<token>/`. */
export const LEGACY_PERSONAL_DIR = 'personal';
export function legacyPersonalAgentLane(uid: string): string {
  return `${AGENTS_DIR}/${LEGACY_PERSONAL_DIR}/${principalToken(uid)}/`;
}

export function dashboardDir(slug: string): string {
  return `${DASHBOARDS_DIR}/${seg(slug, 'dashboard')}`;
}
export function appDir(slug: string): string {
  return `${APPS_DIR}/${seg(slug, 'app')}`;
}
export function connectionDir(name: string): string {
  return `${CONNECTIONS_DIR}/${seg(name, 'connection')}`;
}
export function connectionCatalogPath(name: string): string {
  return `${connectionDir(name)}/catalog.properties`;
}

/** `os/<a>/<b>…` — a path in the OS layer. */
export function osPath(...segments: string[]): string {
  return [OS_DIR, ...segments.map((s) => seg(s, 'os'))].join('/');
}

export const OS_SCHEDULES_PATH = osPath('schedules.yml');
export const OS_SOURCES_PATH = osPath('sources.yml');
export const OS_EXTERNAL_PATH = osPath('external.yml');
export const OS_SKIPPED_PATH = osPath('skipped.yml');
export const OS_LIFECYCLE_DIR = osPath('lifecycle');
export const OS_LIFECYCLE_PINS_PATH = osPath('lifecycle', 'pins.yml');

// --------------------------------------------------------- layout version ---

/** The marker the layout migration (and every v2 repo's first commit) writes. */
export const LAYOUT_MARKER_PATH = osPath('layout.yml');
export const LAYOUT_V1 = 1 as const;
export const LAYOUT_V2 = 2 as const;
export type LayoutVersion = typeof LAYOUT_V1 | typeof LAYOUT_V2;

/** The layout of a tree, from its tracked paths: v2 iff the marker is committed. */
export function layoutOf(paths: Iterable<string>): LayoutVersion {
  for (const p of paths) if (p === LAYOUT_MARKER_PATH) return LAYOUT_V2;
  return LAYOUT_V1;
}

/** The marker file's content. Deterministic: no timestamp. */
export function layoutMarker(dbtDir: string = configuredDbtProjectDir()): string {
  return [
    '# The repository layout version (component design 12). Written by the OS; do not edit.',
    `version: ${LAYOUT_V2}`,
    `dbt_project_dir: ${dbtDir}`,
    `dagster_dir: ${DAGSTER_DIR}`,
    '',
  ].join('\n');
}

/** The dbt project directory of a repo at `layout` ('' = the repo root, v1). */
export function dbtProjectDir(layout: LayoutVersion, dbtDir: string = configuredDbtProjectDir()): string {
  return layout === LAYOUT_V2 ? dbtDir : '';
}

/** dbt-project-relative path → repo path. `os/**` is the OS layer and never moves. */
export function dbtRepoPath(projectPath: string, layout: LayoutVersion, dbtDir: string = configuredDbtProjectDir()): string {
  const dir = dbtProjectDir(layout, dbtDir);
  if (!dir || isOsLayerPath(projectPath)) return projectPath;
  return `${dir}/${projectPath}`;
}

/** Repo path → dbt-project-relative path, or null when the path is not in the dbt project. */
export function dbtProjectPath(repoPath: string, layout: LayoutVersion, dbtDir: string = configuredDbtProjectDir()): string | null {
  const dir = dbtProjectDir(layout, dbtDir);
  if (!dir) return repoPath;
  return repoPath.startsWith(`${dir}/`) ? repoPath.slice(dir.length + 1) : null;
}

export function isOsLayerPath(p: string): boolean {
  return p === OS_DIR || p.startsWith(`${OS_DIR}/`);
}

// ------------------------------------------------------------- migration ---

/** Top-level entries of a v1 tree that are NOT the dbt project (they keep their place). */
export const V1_NON_DBT_TOP_LEVEL: readonly string[] = [AGENTS_DIR, DASHBOARDS_DIR, APPS_DIR, KNOWLEDGE_DIR, CONNECTIONS_DIR, OS_DIR, DATA_DIR];

export type LayoutMove = { from: string; to: string };

/**
 * The `git mv` plan from a v1 tree to v2: every dbt-project file moves under the dbt directory;
 * everything else keeps its path. PURE and deterministic (sorted by source path). The personal
 * agent lanes are NOT moved here — they leave the domain repo for the owner's user repo, which
 * is a separate, per-owner commit (`legacyPersonalAgentLane`).
 */
export function layoutMigrationMoves(paths: Iterable<string>, dbtDir: string = configuredDbtProjectDir()): LayoutMove[] {
  const out: LayoutMove[] = [];
  for (const p of [...paths].sort()) {
    const top = p.split('/')[0];
    if (V1_NON_DBT_TOP_LEVEL.includes(top)) continue;
    out.push({ from: p, to: `${dbtDir}/${p}` });
  }
  return out;
}
