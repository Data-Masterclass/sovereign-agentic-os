/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The `EngineeringView` type — the tool-native artefact of any OS object, serialisable
 * USER STORY: As an engineer I open "Under the hood" on any object the OS built and see the real
 *             dbt model, the real Dagster asset, the compiled LangGraph graph, the git files and
 *             the Langfuse trace — in each tool's own vocabulary, with a deep link and the command
 *             I would run myself — and `get_engineering_view` over MCP gives me the same structure.
 * ARCHITECTURE:
 *   - PURE types + pure helpers. No React, no `server-only`, no I/O, no tab import: the panel
 *     (`core/ui/engineering/`), the MCP tool (`core/mcp/engineering-tools.ts`) and every tab
 *     adapter (`tabs/<tab>/lib/engineering.ts`) agree on this one shape (plan D25).
 *   - Everything here must survive `JSON.stringify` unchanged — the MCP twin returns the identical
 *     structure the panel renders, and `engineering-parity.test.ts` asserts it.
 *   - Honesty is in the type: a section that could not be filled carries `unavailable` (a reason,
 *     never silence), and a link that cannot resolve carries `unresolvedReason` with `url: null`.
 */
import type { CurrentUser } from '@core/kernel/auth';
import type { EngineeringGraph } from '@core/engineering/graph';

/** The tools whose artefacts the OS touches. One panel tab each. */
export const ENGINEERING_TOOLS = ['dbt', 'dagster', 'langgraph', 'git', 'langfuse', 'trino', 'litellm'] as const;
export type EngineeringTool = (typeof ENGINEERING_TOOLS)[number];

/** The object kinds that have an adapter. The MCP tool's `kind` enum is built from this. */
export const ENGINEERING_KINDS = ['dataset', 'metric', 'dashboard', 'agent_system', 'app'] as const;
export type EngineeringKind = (typeof ENGINEERING_KINDS)[number];

/**
 * Who is asking — the signed-in user, never a service principal (global constraint). It is the
 * whole `CurrentUser` so an adapter can call its tab's own gate without re-shaping anything
 * (`import type` only: no runtime edge from this pure module to the auth kernel).
 */
export type EngineeringPrincipal = CurrentUser;

/** A short, factual key/value the tool itself would print (asset key, run id, thread id). */
export type EngineeringFact = { label: string; value: string };

/** How the panel should render `body` (and nothing more — no highlighting promises). */
export type ArtefactLanguage = 'sql' | 'yaml' | 'json' | 'text';

/**
 * ONE artefact as the tool stores it. `body` is the real bytes — the SQL that runs, the YAML in
 * the repo, the compiled graph — never a paraphrase (the plan's "show the real thing" rule).
 */
export type EngineeringArtefact = {
  /** The tool's own noun: "dbt model", "Dagster asset", "LangGraph node". */
  noun: string;
  /** The tool-native name: the model name, `["ops","orders"]`, `plan_analyst`. */
  name: string;
  /** Where the bytes live in the domain repository, when the artefact is a file. */
  repoPath?: string;
  language?: ArtefactLanguage;
  /** The bytes, when we have them. Absent + `note` when we only know that it exists. */
  body?: string;
  /** Why there is no `body` — required when `body` is absent. */
  note?: string;
  facts?: EngineeringFact[];
};

/** A deep link into the tool. `url: null` must carry `unresolvedReason` (checklist T7). */
export type EngineeringLink = {
  label: string;
  url: string | null;
  unresolvedReason?: string;
};

/** The command an engineer would run outside the OS to do the same thing. */
export type EngineeringCommand = {
  tool: EngineeringTool;
  /** Exactly as it is typed, with the real node / asset / id substituted in. */
  command: string;
  /** One line: what it does. */
  description: string;
};

/** One panel tab: one tool's view of this object. */
export type EngineeringSection = {
  tool: EngineeringTool;
  /** The tab label — the tool's own name ("dbt", "Dagster", "LangGraph"). */
  label: string;
  /** The heading: the tool's noun first, the OS term in parentheses at most once. */
  title: string;
  artefacts: EngineeringArtefact[];
  links: EngineeringLink[];
  commands: EngineeringCommand[];
  /** Why this section is empty. REQUIRED when `artefacts` is empty — never a blank tab. */
  unavailable?: string;
  /** Where the OS still does this its own way (`docs/components/trino.md`'s honesty pattern). */
  caveats?: string[];
  /**
   * The compiled graph, when this section has one (LangGraph only). The same structure the
   * section's JSON artefact serialises — carried typed as well so the diagram does not re-parse
   * and cannot drift from the JSON an engineer reads beside it.
   */
  graph?: EngineeringGraph;
};

/** The native export of the whole artefact, in the tool's own format (plan D26). */
export type EngineeringExport = {
  /** The tool's noun for what is exported: "dbt project tarball". */
  label: string;
  /** Where the UI fetches it, or null with a reason. */
  href: string | null;
  unresolvedReason?: string;
  /** The exact commands to run the export elsewhere, in order. */
  commands: string[];
};

/** Everything the panel renders and `get_engineering_view` returns. Pure JSON. */
export type EngineeringView = {
  kind: EngineeringKind;
  id: string;
  /** The object's OS name — the panel header only; every other label is a tool noun. */
  name: string;
  domain: string | null;
  sections: EngineeringSection[];
  export?: EngineeringExport;
};

/** An adapter: the tab's own gated read, then the tool-native description. Pure of React. */
export type EngineeringAdapter = (principal: EngineeringPrincipal, id: string) => Promise<EngineeringView>;

/** A section whose tool we could not reach, with the reason the user sees. */
export function unavailableSection(
  tool: EngineeringTool,
  label: string,
  title: string,
  reason: string,
): EngineeringSection {
  return { tool, label, title, artefacts: [], links: [], commands: [], unavailable: reason };
}

/** A link that cannot resolve — the reason is mandatory here, not optional (checklist T7). */
export function unresolvedLink(label: string, reason: string): EngineeringLink {
  return { label, url: null, unresolvedReason: reason };
}

/**
 * The view, with every honesty invariant checked. Adapters end with this so a section that
 * forgot its reason fails loudly in a test rather than rendering as an empty tab.
 */
export function sealView(view: EngineeringView): EngineeringView {
  for (const s of view.sections) {
    if (s.artefacts.length === 0 && !s.unavailable) {
      throw new Error(`engineering view ${view.kind}:${view.id}: section '${s.tool}' is empty and gives no reason`);
    }
    for (const a of s.artefacts) {
      if (a.body === undefined && !a.note) {
        throw new Error(`engineering view ${view.kind}:${view.id}: artefact '${a.name}' has no body and no note`);
      }
    }
    for (const l of s.links) {
      if (l.url === null && !l.unresolvedReason) {
        throw new Error(`engineering view ${view.kind}:${view.id}: link '${l.label}' does not resolve and does not say why`);
      }
    }
  }
  if (view.export && view.export.href === null && !view.export.unresolvedReason) {
    throw new Error(`engineering view ${view.kind}:${view.id}: the export does not resolve and does not say why`);
  }
  return view;
}
