/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `engineeringView('dashboard', id)` — this tab's adapter for the Under-the-hood panel
 * USER STORY: As a data engineer I want to open a dashboard and see the REAL artefacts — the
 *             dashboard-as-code file in the domain repo, the governed metric ids it resolves, the
 *             Trino principal its numbers run as, and the command I would run myself — in the
 *             tools' own vocabulary, with the export that lets me take it elsewhere (D25, D26).
 * ARCHITECTURE:
 *   - THE CONTRACT FOR STREAM T. T owns `core/engineering/` (the `EngineeringView` type and the
 *     adapter registry) and `core/ui/engineering/` (the one shared panel). This file is the
 *     dashboards adapter T registers. It is declared against the shape the plan fixes rather than
 *     importing `core/engineering` — that module is not in the tree yet, and a tab may not import
 *     something that does not compile. When T lands it, the local types are deleted and the import
 *     replaces them: the SHAPE is what matters, and it is pinned by `lib/engineering.test.ts`.
 *   - PURE and MCP-serialisable: data in, a JSON-safe structure out. No store read, no fetch, no
 *     clock — so `get_engineering_view({kind:'dashboard', id})` and the panel render the identical
 *     structure, and both are testable without a cluster (D25).
 *   - VOCABULARY RULE (T2): every label is the TOOL's own noun — "Trino query", "dbt metric",
 *     "git commit", "dashboard-as-code" — with the OS term in parentheses at most once. A panel
 *     label that uses only an OS-invented noun fails T's test.
 *   - HONESTY: where the OS cannot resolve something, the view SAYS SO in its own words rather
 *     than omitting it — an unresolved metric id, a dashboard with no commit yet, a deep link that
 *     cannot resolve. The "what is NOT true yet" pattern, not a blank field.
 *   - MOUNTS NOTHING. No header, no route, no component: G and T own the mounts.
 */
import type { SnapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';
import { DASHBOARDS_PREFIX, sourcesOf, UNRESOLVED_REF } from '@tabs/dashboards/lib/git/generate';

// --------------------------------------------------------------------------------------------
// The shape stream T owns. Declared here only until `core/engineering/` lands (see ARCHITECTURE).
// --------------------------------------------------------------------------------------------

/** One fact about a tool-native artefact: the tool's own label and its value. */
export type EngineeringFact = { label: string; value: string; /** Why this is absent/approximate. */ note?: string };

/** A file the OS wrote, shown as the bytes that are in the repo. */
export type EngineeringFile = { path: string; language: 'yaml' | 'markdown' | 'sql' | 'json'; contents: string };

/** The command an engineer would run to do the same thing outside the OS. */
export type EngineeringCommand = { label: string; command: string; note?: string };

/** An export in the artefact's NATIVE form — "you could take this and leave" (D26). */
export type EngineeringExport = { label: string; filename: string; how: string };

/** One tool's tab in the Under-the-hood panel. */
export type EngineeringTool = {
  /** The tool's own name, as an engineer says it: `git`, `Trino`, `dbt`, `Dagster`, `Langfuse`. */
  tool: string;
  facts: EngineeringFact[];
  files?: EngineeringFile[];
  commands?: EngineeringCommand[];
  /** A deep link into the tool, or the honest reason there is none. */
  link?: { href: string; label: string } | { unavailable: string };
};

/** What the shared panel and `get_engineering_view` both render. */
export type EngineeringView = {
  kind: string;
  id: string;
  /** The OS object's display name, for the panel header. */
  name: string;
  tools: EngineeringTool[];
  exports: EngineeringExport[];
  /** What is NOT true yet for this kind — shown verbatim, never hidden. */
  caveats: string[];
};

// --------------------------------------------------------------------------------------------

/** Everything the adapter needs, resolved by the caller (T's registry) so this stays pure. */
export type DashboardEngineeringInput = {
  /** The dashboard, flattened exactly as the git generator sees it. */
  dashboard: SnapshotDashboard;
  /** The owning domain (its repository name). */
  domain: string;
  /** The repo-relative directory the dashboard lives in (`placeDashboards` decided it). */
  dir: string;
  /** The committed `dashboard.yaml` bytes, when they can be read. */
  yaml?: string;
  /** The subtree's head commit sha, when the git read-back resolves it (stream G's `objectGitInfo`). */
  headSha?: string;
  /** The Trino principal a panel's query runs as — the VIEWER, never a service account. */
  trinoPrincipal?: string;
  /** The base URL an engineer clones from, e.g. `https://os.example.com`. */
  gitBaseUrl?: string;
};

/** The governed ids this dashboard depends on, as the tools' own nouns. */
function sourceFacts(d: SnapshotDashboard): EngineeringFact[] {
  const facts: EngineeringFact[] = [];
  for (const s of sourcesOf(d)) {
    if (s.ref === UNRESOLVED_REF) {
      facts.push({
        label: 'dbt metric (KPI)',
        value: s.member ?? '—',
        note: 'No governed metric id resolves this member in this domain, so the file records it as `unresolved` rather than inventing an id. The panel shows the OS’s missing-member warning until the metric exists.',
      });
      continue;
    }
    if (s.view) {
      facts.push({ label: 'dbt model (data product)', value: `${s.ref} — view \`${s.view}\`` });
      continue;
    }
    facts.push({ label: 'dbt metric (KPI)', value: `${s.ref} — member \`${s.member}\`` });
  }
  return facts;
}

/**
 * The dashboards adapter. `kind` is checked so T's registry can call every adapter through one
 * signature and a mis-registration fails loudly rather than rendering the wrong object.
 */
export function engineeringView(kind: string, id: string, input: DashboardEngineeringInput): EngineeringView {
  if (kind !== 'dashboard') {
    throw new Error(`engineeringView: tabs/dashboards handles kind 'dashboard', not '${kind}'`);
  }
  const d = input.dashboard;
  if (d.id !== id) {
    throw new Error(`engineeringView: asked for dashboard '${id}' but given '${d.id}'`);
  }
  const yamlPath = `${input.dir}/dashboard.yaml`;
  const clone = `${input.gitBaseUrl ?? '<os>'}/git/${input.domain}.git`;

  const git: EngineeringTool = {
    tool: 'git',
    facts: [
      { label: 'Repository', value: `${input.domain}.git` },
      { label: 'Path', value: yamlPath },
      input.headSha
        ? { label: 'Head commit', value: input.headSha }
        : {
            label: 'Head commit',
            value: 'not resolved',
            note: 'The git read-back could not resolve a commit for this dashboard. Either it has not been committed yet (the dashboard-as-code commit path is gated by DATA_PROJECT_GIT), or it was written by a boot reconcile, whose commits carry platform attribution rather than a per-object trailer.',
          },
      { label: 'Subtree', value: DASHBOARDS_PREFIX, note: 'Reserved for this tab, so the dbt project’s whole-tree commit never deletes it.' },
    ],
    files: input.yaml ? [{ path: yamlPath, language: 'yaml', contents: input.yaml }] : undefined,
    commands: [
      { label: 'Clone the domain repository', command: `git clone ${clone}` },
      { label: 'Read this dashboard’s history', command: `git log --stat -- ${yamlPath}` },
      { label: 'See the last change', command: `git show HEAD -- ${yamlPath}` },
    ],
  };

  const trino: EngineeringTool = {
    tool: 'Trino',
    facts: [
      { label: 'Governed view', value: d.view },
      input.trinoPrincipal
        ? { label: 'Trino query runs as', value: input.trinoPrincipal, note: 'The signed-in viewer — never a service account. Two viewers of this dashboard get different rows.' }
        : {
            label: 'Trino query runs as',
            value: 'the signed-in viewer',
            note: 'Resolved per request from the viewer’s delegated token; there is no fixed principal to show outside a request.',
          },
      {
        label: 'Ad-hoc SQL',
        value: 'not possible',
        note: 'A panel addresses governed metric members only. The format has no SQL field and the reader refuses one, so a dashboard cannot put a number outside the metric registry or outside its row-level security.',
      },
    ],
    commands: [
      {
        label: 'Run a panel’s query yourself',
        command: `trino --execute '<the SQL the panel shows under “View query”>'`,
        note: 'The SQL shown in the panel is the SQL that ran, as you. Running it in a shell runs it as YOUR Trino principal, which is the point.',
      },
    ],
  };

  const metrics: EngineeringTool = {
    tool: 'dbt',
    facts: sourceFacts(d).length > 0 ? sourceFacts(d) : [{ label: 'dbt metric (KPI)', value: 'none — this dashboard has no panels yet' }],
    commands: [
      { label: 'Build a metric’s model', command: 'dbt build --select <model>' },
      { label: 'Test it', command: 'dbt test --select <model>' },
    ],
  };

  const tools: EngineeringTool[] = [git, trino, metrics];

  const caveats: string[] = [
    'A dashboard is NOT a Superset artefact and is not importable by Superset. The OS format is its own, with stable OS ids instead of UUID cross-references; the line, area and bar charts are drawn by Apache Superset’s own ECharts transformers, vendored as source and attributed, which is a different thing from running Superset.',
    'Layout, a native filter bar, tabs, a dashboard-level time range and a pivot table are NOT built yet. A dashboard with no grid positions renders in panel order, and the file writes no `layout` block rather than inventing one.',
  ];
  if (!d.lifecycle) {
    caveats.push(
      'No lifecycle version is pinned for this dashboard, so there is no “this is the version that is running” answer yet. Lifecycle (Draft · Testing · Live) is owned elsewhere in the OS; this tab records the pin when one exists and says nothing when it does not.',
    );
  }

  return {
    kind: 'dashboard',
    id: d.id,
    name: d.name,
    tools,
    exports: [
      {
        label: 'Dashboard as code (native)',
        filename: 'dashboard.yaml',
        how: `The committed file itself: \`git show HEAD:${yamlPath}\`, or clone the domain repository and read ${yamlPath}. It is the whole dashboard — hand-edit it, push it, and the OS validates it with the same schema the UI uses.`,
      },
      {
        label: 'The domain repository (native)',
        filename: `${input.domain}.tar`,
        how: `\`git clone ${clone}\` — the dbt project, the agent systems and every dashboard, as one repository you can keep.`,
      },
    ],
    caveats,
  };
}
