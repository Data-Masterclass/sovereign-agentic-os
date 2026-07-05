/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
import { ROLES, type Role } from '@/lib/session';
import type { ToolTab, McpTab } from './server';
import { loadGuide, type GuidePath } from '@/lib/tabs/guides';

/**
 * MCP PROMPTS — user-controlled, parameterized workflow templates surfaced by
 * clients as slash commands (e.g. /sovereign-agentic-os:build_data_product). A
 * prompt TEACHES the golden path: it embeds the pathway guide, a LIVE role
 * banner, and the exact tool sequence with inline ⛔ Builder/Admin checkpoints.
 *
 * Prompts render TEXT ONLY — `prompts/get` executes nothing, so a prompt can
 * NEVER bypass governance. A creator who follows `build_data_product` to the
 * promote step still hits the Builder floor inside `approve_promotion` and gets
 * the typed forbidden + hint. The prompt is role-aware and SAYS SO up front.
 */

export type PromptMessage = {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
};

export type McpPrompt = {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  tab: ToolTab;
  minRole: Role;
  /** The pathway guide this prompt embeds (its full how-to). */
  guide: GuidePath;
  /** Build the parameterized step script (the guide + banner + rules wrap it). */
  script: (args: Record<string, string>) => string;
};

function rank(role: Role): number {
  return ROLES.indexOf(role);
}
const isBuilder = (role: Role) => rank(role) >= rank('builder');
const isAdmin = (role: Role) => rank(role) >= rank('admin');

/** A live, role-aware banner rendered from the CALLER's identity. */
function roleBanner(user: CurrentUser): string {
  const gate = isBuilder(user.role)
    ? isAdmin(user.role)
      ? 'You CAN approve promotions, deploys, AND certify to the marketplace / own cross-domain bets.'
      : 'You CAN approve Personal→Shared promotions and deploys in your domain(s). You CANNOT certify to the marketplace (Admin only).'
    : 'You are a CREATOR: you build/run your own work and FILE promotion requests, but you CANNOT promote/publish/approve. At a ⛔ step, hand off to a Builder.';
  return `— YOUR ROLE: ${user.role} in domain(s) [${user.domains.join(', ') || 'none'}]. ${gate} —`;
}

const RULES = [
  'Standing rules:',
  '- DISCOVER before you create: reuse existing ids (read sovereign-os://my/* or call the list_* tool).',
  '- Use ONLY these OS tools for OS artifacts. Never fabricate an id, never invent a bypass.',
  '- Tool errors are typed {code, reason, hint} — follow the hint (forbidden → ask a Builder or keep it Personal; conflict → already done, idempotent).',
  '- Everything runs AS you: OPA-checked, DLS-filtered, audit-traced.',
].join('\n');

const arg = (name: string, description: string, required = false) => ({ name, description, required });

// --- The 11 golden-path prompts -----------------------------------------------
export const PROMPTS: McpPrompt[] = [
  {
    name: 'build_data_product',
    title: 'Build a data product',
    description: 'Bronze→Silver→Gold dataset, documented, ready to promote to a governed domain asset.',
    arguments: [arg('name', 'Dataset name', true), arg('domain', 'Your domain'), arg('source_description', 'What the source data is')],
    tab: 'data',
    minRole: 'creator',
    guide: 'data',
    script: (a) => [
      `GOAL: build the data product "${a.name || '<name>'}"${a.domain ? ` in domain ${a.domain}` : ''}.`,
      a.source_description ? `Source: ${a.source_description}` : '',
      'Steps:',
      '1. whoami — confirm your role + domains.',
      '2. list_datasets — reuse/extend an existing spine before creating a new one.',
      `3. create_dataset(name: "${a.name || '<name>'}"${a.domain ? `, domain: "${a.domain}"` : ''}).`,
      '4. add_dataset_version(layer: "bronze") → silver (authored dbt SQL + not_null/unique tests) → gold.',
      '5. document_dataset — description + column docs. (Docs are the PROMOTION GATE.)',
      '6. request_promotion(kind: "dataset", id) — file the promotion request.',
      '⛔ Builder+ only: approve_promotion(approvalId) applies it into Trino. A creator STOPS here and hands off.',
      '7. Optional: define_metric on the gold version.',
    ].filter(Boolean).join('\n'),
  },
  {
    name: 'author_and_publish_knowledge',
    title: 'Author & publish knowledge',
    description: 'Capture a workflow (steps + rules + tacit), index it, and publish it Shared.',
    arguments: [arg('topic', 'What the workflow is about', true), arg('domain', 'Your domain')],
    tab: 'knowledge',
    minRole: 'creator',
    guide: 'knowledge',
    script: (a) => [
      `GOAL: capture and publish knowledge on "${a.topic || '<topic>'}"${a.domain ? ` in domain ${a.domain}` : ''}.`,
      'Steps:',
      `1. whoami.`,
      `2. search_knowledge(query: "${a.topic || '<topic>'}") — dedupe before authoring.`,
      '3. author_knowledge — steps (each with a Human/Software/Agent actor), rules (mark hard rules), and tacit context.',
      '4. index_knowledge — so search returns it.',
      '5. search_knowledge again to verify it is retrievable (cite provenance).',
      '⛔ Builder+ only: publish_knowledge(workflowId) — draft→live + reindex. A creator STOPS here.',
    ].join('\n'),
  },
  {
    name: 'connect_data_source',
    title: 'Connect a data source',
    description: 'Create + test a Personal connection, then promote it to a shared domain source.',
    arguments: [arg('system', 'The system to connect (e.g. Notion, Salesforce)', true), arg('kind', 'Template key')],
    tab: 'connections',
    minRole: 'creator',
    guide: 'connections',
    script: (a) => [
      `GOAL: connect "${a.system || '<system>'}"${a.kind ? ` (template ${a.kind})` : ''}.`,
      'Steps:',
      '1. whoami.',
      '2. list_connections — reuse an existing connection first.',
      `3. create_connection(name, template${a.kind ? `: "${a.kind}"` : ''}, endpoint, credential) — Personal; credential is stored server-side, never returned.`,
      '4. test_connection(connId) — expect live | offline.',
      '⛔ Builder+ only: promote_connection(connId) → shared domain source. A creator STOPS here.',
      '5. Consume it from an app with use_connection(appId, ref) — BY REFERENCE, never raw creds.',
    ].join('\n'),
  },
  {
    name: 'build_agent_system',
    title: 'Build an agent system',
    description: 'Assemble, ground, commit and verify a LangGraph agent system.',
    arguments: [arg('goal', 'What the agent system should do', true), arg('domain', 'Your domain'), arg('template', 'blank|analyze|evaluate|recommend')],
    tab: 'agents',
    minRole: 'creator',
    guide: 'agents',
    script: (a) => [
      `GOAL: build an agent system for "${a.goal || '<goal>'}"${a.domain ? ` in domain ${a.domain}` : ''}.`,
      'Steps:',
      '1. whoami.',
      '2. list_agent_systems — reuse before creating.',
      `3. search_knowledge — ground the agents in governed knowledge.`,
      `4. create_agent_system(name${a.domain ? `, domain: "${a.domain}"` : ''}${a.template ? `, template: "${a.template}"` : ''}).`,
      '5. commit_agent_files — ONLY system.yaml, agents/<id>/AGENT.md, MEMORY.md (a whitelist). Sub-agent grants ⊆ system grants.',
      '6. build_agent_system(systemId) — compile + verify (✓/✗ rows + Langfuse traces).',
      '⛔ Sharing is the promote ladder: Builder→Shared, Admin→Marketplace. A creator keeps it Personal.',
    ].join('\n'),
  },
  {
    name: 'build_and_ship_software',
    title: 'Build & ship software',
    description: 'Create an app, wire governed dependencies by reference, preview, and ship via review.',
    arguments: [arg('name', 'App name', true), arg('template', 'Template key'), arg('consumes', 'Resources to consume')],
    tab: 'software',
    minRole: 'creator',
    guide: 'software',
    script: (a) => [
      `GOAL: build and ship the app "${a.name || '<name>'}"${a.template ? ` (template ${a.template})` : ''}.`,
      a.consumes ? `Consumes: ${a.consumes}` : '',
      'FIRST read the canonical build spec: sovereign-os://guide/build-spec/software',
      '(template tree · tool sequence · governance · elicitation questions · pre-deploy checklist).',
      'Note: preview + live deploy are pending the in-cluster runner (next release) — never claim a working URL.',
      'Steps:',
      '1. whoami + list_software (reuse first).',
      `2. create_software(name: "${a.name || '<name>'}"${a.template ? `, template: "${a.template}"` : ''}).`,
      '3. commit(appId, files) — declare consumed connections/data/knowledge in .app/.',
      '4. Wire deps BY REFERENCE: use_data / use_knowledge / use_connection(appId, ref).',
      '5. start_preview(appId) — private, no review.',
      '6. request_deploy(appId) — opens the Builder review card.',
      '⛔ Builder+ only: decide_deploy(cardId, "approve") → live subdomain. A creator STOPS here.',
      '7. Optional: use_as_data(appId) closes the loop app → Bronze.',
    ].filter(Boolean).join('\n'),
  },
  {
    name: 'define_metric',
    title: 'Define a governed metric',
    description: 'Turn a gold, governed dataset into the one definition of a number.',
    arguments: [arg('metric_name', 'The metric to define', true), arg('dataset', 'Gold governed dataset id')],
    tab: 'metrics',
    minRole: 'creator',
    guide: 'metrics',
    script: (a) => [
      `GOAL: define the metric "${a.metric_name || '<metric>'}"${a.dataset ? ` on dataset ${a.dataset}` : ''}.`,
      'Steps:',
      '1. whoami.',
      '2. list_datasets — the dataset MUST be a GOVERNED gold asset. If not, run build_data_product first.',
      '3. list_metrics — do not duplicate an existing member.',
      `4. define_metric(datasetId, name: "${a.metric_name || '<metric>'}", aggregation, column?, dimensions?). count needs no column; other aggregations need a gold column.`,
      '5. Verify the canonical Cube member came back.',
    ].join('\n'),
  },
  {
    name: 'build_dashboard',
    title: 'Build a dashboard',
    description: 'Compose charts over governed metric members with per-viewer RLS.',
    arguments: [arg('name', 'Dashboard name', true), arg('focus', 'What it should show')],
    tab: 'dashboards',
    minRole: 'creator',
    guide: 'dashboards',
    script: (a) => [
      `GOAL: build the dashboard "${a.name || '<name>'}"${a.focus ? ` focused on ${a.focus}` : ''}.`,
      'Steps:',
      '1. whoami + list_metrics.',
      '2. define_metric for any missing member.',
      `3. create_dashboard(name: "${a.name || '<name>'}", view, charts[]) — every chart binds a governed metric member.`,
      '⛔ Widening the tier NEVER widens rows (per-viewer RLS). Sharing wider is a Builder/Admin step.',
    ].join('\n'),
  },
  {
    name: 'create_big_bet',
    title: 'Frame a Big Bet',
    description: 'Frame an initiative over REAL OS components and track its value.',
    arguments: [arg('problem', 'The problem statement', true), arg('owner', 'Who owns the problem')],
    tab: 'bigbets',
    minRole: 'creator',
    guide: 'bigbets',
    script: (a) => [
      `GOAL: frame a Big Bet for "${a.problem || '<problem>'}"${a.owner ? ` owned by ${a.owner}` : ''}.`,
      'Steps:',
      '1. whoami.',
      '2. list_datasets + list_dashboards + list_agent_systems — the bet tracks REAL components.',
      `3. create_big_bet(problem: "${a.problem || '<problem>'}"${a.owner ? `, owner: "${a.owner}"` : ''}) referencing a pillar + north-star metric.`,
      '⛔ A creator files a DRAFT; an ACTIVE bet needs a Builder/Admin owner; cross-domain = Admin.',
      '4. Attach the real component ids and track realized value vs target.',
    ].join('\n'),
  },
  {
    name: 'upload_and_share_file',
    title: 'Upload & share a file',
    description: 'Upload a governed file with docs + tags, then promote it to a domain asset.',
    arguments: [arg('name', 'File name', true), arg('purpose', 'What the file is for')],
    tab: 'files',
    minRole: 'creator',
    guide: 'files',
    script: (a) => [
      `GOAL: upload and share the file "${a.name || '<name>'}"${a.purpose ? ` (${a.purpose})` : ''}.`,
      'Steps:',
      '1. whoami.',
      `2. search_files(query: "${a.name || '<name>'}") — dedupe.`,
      '3. upload_file(name, text, tags, description) — a description + ≥1 tag make it promote-eligible; restricted = stored-not-indexed.',
      '4. request_promotion(kind: "file", id) — file the promotion request.',
      '⛔ Builder+ only: approve_promotion(approvalId) re-governs the prefix + DLS. A creator STOPS here.',
    ].join('\n'),
  },
  {
    name: 'score_and_wire_prediction',
    title: 'Score & wire a prediction',
    description: 'Score a governed ML model through the predict door, then wire the score into an agent or app.',
    arguments: [arg('model', 'Registry model name (e.g. churn_model)'), arg('account', 'The account/entity to score')],
    tab: 'science',
    minRole: 'creator',
    guide: 'science',
    script: (a) => [
      `GOAL: score ${a.model ? `the model "${a.model}"` : 'a governed ML model'}${a.account ? ` for account ${a.account}` : ''} and wire the prediction into a governed consumer.`,
      'Steps:',
      '1. whoami — your identity + domains (tier scope decides which models you can call).',
      '2. list_models — the models YOU can score (read sovereign-os://my/science). HONEST CHECK: if the response says ml.enabled=false, predictions will 404 — report that and stop; an Admin must enable ML. If the list is empty, there is no model to score — never invent one.',
      `3. get_model(model${a.model ? `: "${a.model}"` : ''}) — read the card: feature names, default features, score bands, versions + AUC, tier and serving status.`,
      `4. science_predict(${a.account ? `account: "${a.account}"` : 'account'}, features?) — score through the GOVERNED predict door (never a raw model endpoint). Use only feature names from the card. Read score / band / traceId back.`,
      '5. Wire the score into a consumer through the same governed door:',
      '   • an AGENT: grant the system the predict tool in system.yaml (commit_agent_files) — its calls run grant-scoped, as the runner;',
      '   • an APP: consume by reference (use_data / the REST predict door) — never embed a model endpoint or secret.',
      '⛔ Widening WHO can call the model is the promote ladder (Builder → Domain, Admin → Marketplace), always a human — an agent can never promote a model.',
    ].join('\n'),
  },
  {
    name: 'orient_me',
    title: 'Orient me',
    description: 'Read your identity, capabilities, and everything that already exists.',
    arguments: [],
    tab: 'meta',
    minRole: 'creator',
    guide: 'overview',
    script: () => [
      'GOAL: get oriented in the Sovereign Agentic OS.',
      'Steps:',
      '1. whoami — your identity, role, domains, and what you can/cannot do.',
      '2. list_capabilities — every tool split into available vs gated.',
      '3. Read sovereign-os://guide/overview and sovereign-os://guide/governance (or get_guide).',
      '4. Read your inventories: sovereign-os://my/datasets, my/knowledge, my/connections, my/files, my/metrics, my/dashboards, my/agents, my/software, my/bigbets, my/science (or the list_* tools).',
      '5. Summarize: "here is what exists, and here is what you may do" — then pick a golden-path prompt.',
    ].join('\n'),
  },
];

/** Render a prompt to MCP `prompts/get` messages: guide + live banner + script + rules. */
export function renderPrompt(prompt: McpPrompt, user: CurrentUser, args: Record<string, string>): PromptMessage[] {
  const guide = loadGuide(prompt.guide);
  const text = [
    roleBanner(user),
    '',
    prompt.script(args),
    '',
    RULES,
    '',
    guide ? `--- GUIDE: ${prompt.guide} ---\n${guide}` : '',
  ].filter(Boolean).join('\n');
  return [{ role: 'user', content: { type: 'text', text } }];
}

// --- Endpoint scoping (mirrors toolsForTab): a tab serves its own + meta -------
export function promptsForTab(tab: McpTab, all: McpPrompt[] = PROMPTS): McpPrompt[] {
  return all.filter((p) => p.tab === tab || p.tab === 'meta');
}
