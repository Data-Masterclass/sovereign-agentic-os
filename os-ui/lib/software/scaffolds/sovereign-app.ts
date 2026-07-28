/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The SOVEREIGN STANDARD APP template — the "base app" every new Software-tab
 * app scaffolds from. Like vite-os.ts this module is PURE DATA (`{path,content}[]`)
 * written into the per-app Forgejo repo by the seeder; it is never compiled as
 * live os-ui source.
 *
 * A fresh app already IS a Sovereign OS app before the first epic is built:
 *
 *   • AppShell chrome — left section nav + top bar (@sovereign-os/ui).
 *   • OS-DELEGATED identity — the app reads the OS session (`os.whoami()`), shows
 *     the signed-in user (name / role / domain) and an honest "not signed in via
 *     the OS" screen when there is none. NO local accounts or passwords, ever.
 *   • Multi-tenant awareness — the owning domain is derived from the app's own
 *     host (`<slug>.<domain>.<apps-domain>`), shown as a badge, and the scope
 *     helpers (template/scope.ts) filter every record by domain + user (My / Domain).
 *   • Admin section — OS domain_admin/admin only: settings placeholder + a
 *     READ-ONLY list of the OS users who can reach the app. Managing users stays
 *     in the OS.
 *   • MCP — a top-bar button linking to this app's MCP connection in the OS
 *     Connections tab (deterministic: the connection principal is `app-<slug>`).
 *
 * CODE STRUCTURE (mirrors the epic/story spec — see CODE_STRUCTURE_CONVENTION):
 *
 *   • src/template/  — the FIXED scaffold (identity, roles, scope, app-meta, the
 *                      admin shell + AppShell layout, the section registry). Stays
 *                      fixed unless a developer overrides it.
 *   • src/core/      — overarching custom functionality + SHARED data/store code and
 *                      shared pages (the governed data plane lives here, not Supabase).
 *   • src/epics/     — empty at scaffold time; the Build stage adds
 *                      epics/<epicKey>/general/ (epic-wide) and
 *                      epics/<epicKey>/<storyKey>/ (a story's feature + its data).
 *   • src/App.tsx / src/main.tsx — THIN entrypoints only (Vite's router layer):
 *                      main boots React, App renders the template Shell. Real logic
 *                      lives in template/·core/·epics/, never in these entrypoints.
 *
 * The Build stage fills in business features epic-by-epic: each story adds its page
 * under src/epics/<epic>/<story>/ and registers ONE SECTIONS entry
 * (src/template/sections.tsx). README.md documents that contract for the building
 * agent, and the same text is the app's `docs` so the Build assistant reads it.
 *
 * Infra files (Vite config, Tailwind, Dockerfile, nginx, CI, OpenAPI stub) are
 * shared with the vite-os template via `viteBaseFiles` so serving never drifts.
 */
import { viteBaseFiles, viteOsClientFile, type ScaffoldFile } from './vite-os.ts';

export type { ScaffoldFile };

/** All files the Sovereign standard app template seeds into a new app repo. */
export function sovereignAppFiles(name: string, slug: string): ScaffoldFile[] {
  return [
    ...viteBaseFiles(name, slug),
    viteOsClientFile(),
    viteEnvDts(),
    // Thin entrypoints (Vite's router layer) — real logic lives in template/·core/·epics/.
    srcMainTsx(),
    srcAppTsx(),
    // template/ — the FIXED scaffold.
    templateAppMetaTs(name, slug),
    templateRolesTs(),
    templateIdentityTsx(),
    templateScopeTs(),
    templateSectionsTsx(),
    templateShellTsx(),
    templatePageOverviewTsx(),
    templatePageAdminTsx(),
    // core/ — overarching custom functionality + shared governed-data store + shared pages.
    coreStoreTs(),
    corePageWorkspaceTsx(),
    // epics/ — empty at scaffold time; the Build stage fills it in.
    epicsReadme(),
    appYaml(name, slug),
    decisionsMd(name),
    readmeMd(name, slug),
  ];
}

// ------------------------------------------------------------ src/vite-env.d.ts --

function viteEnvDts(): ScaffoldFile {
  return {
    path: 'src/vite-env.d.ts',
    content: [
      '/// <reference types="vite/client" />',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------- src/main.tsx --

function srcMainTsx(): ScaffoldFile {
  return {
    path: 'src/main.tsx',
    content: [
      "import { StrictMode } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "import './index.css';",
      "import App from './App.tsx';",
      '',
      '// THIN entrypoint (Vite router layer). Boot in the OS dark-luxury look',
      '// (gold-on-black). Remove this line for the light theme — the .sb-* chrome adapts',
      '// to both. Nav chrome stays dark either way. All real logic lives under',
      '// src/template/ (fixed scaffold), src/core/ (shared) and src/epics/ (features).',
      "document.documentElement.setAttribute('data-theme', 'dark');",
      '',
      "createRoot(document.getElementById('root')!).render(",
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>,',
      ');',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------------- src/App.tsx --

function srcAppTsx(): ScaffoldFile {
  return {
    path: 'src/App.tsx',
    content: [
      "import { IdentityProvider } from './template/identity.tsx';",
      "import Shell from './template/shell.tsx';",
      '',
      '/**',
      ' * THIN entrypoint (Vite router layer). It ONLY wires the fixed template Shell',
      ' * inside the OS identity provider — no business logic here. The shell, identity,',
      ' * scope and section registry live in src/template/ (the FIXED scaffold); features',
      ' * live under src/epics/<epic>/<story>/ and shared code in src/core/.',
      ' */',
      'export default function App() {',
      '  return (',
      '    <IdentityProvider>',
      '      <Shell />',
      '    </IdentityProvider>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------- src/template/app-meta.ts --

function templateAppMetaTs(name: string, slug: string): ScaffoldFile {
  return {
    path: 'src/template/app-meta.ts',
    content: [
      '/**',
      ' * App identity + OS locations. Everything here is derived HONESTLY: baked at',
      ' * scaffold/build time or read from the deployed hostname — never guessed.',
      ' * FIXED scaffold (template/): do not change unless overriding the base app.',
      ' */',
      '',
      `export const APP_NAME = ${JSON.stringify(name)};`,
      `export const APP_SLUG = ${JSON.stringify(slug)};`,
      '',
      "/** OS base URL baked at build time (Dockerfile ARG OS_API_URL → VITE_OS_API).",
      " *  '' = same-origin — correct inside the OS instant preview. When the build arg",
      ' *  is missing (a rebuild that predates the OS injecting it), fall back to deriving',
      ' *  the OS origin from this deployed app host — apps are served on',
      ' *  `<slug>.<domain>.<appsDomain>`, so the OS is the parent registrable domain',
      " *  (drop the leading `<slug>.<domain>` labels). Never guesses inside the OS",
      ' *  preview / localhost (returns \'\' there → same-origin, which is correct). */',
      'export function osBaseUrl(): string {',
      "  const baked = (import.meta.env.VITE_OS_API as string | undefined) ?? '';",
      '  if (baked) return baked.replace(/\\/+$/, \'\');',
      '  return deriveOsOriginFromHost();',
      '}',
      '',
      '/** Derive the OS origin from the deployed app host (build-arg fallback only). */',
      'export function deriveOsOriginFromHost(hostname: string = typeof window !== \'undefined\' ? window.location.hostname : \'\'): string {',
      "  if (!hostname || hostname === 'localhost' || /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(hostname)) return '';",
      "  const labels = hostname.split('.');",
      '  // Need at least `<slug>.<domain>.<root...>` and the first label to be our slug.',
      '  if (labels.length < 4 || labels[0] !== APP_SLUG) return \'\';',
      '  // The OS lives on the parent registrable domain (drop `<slug>.<domain>`).',
      "  const osHost = labels.slice(2).join('.');",
      "  return `https://${osHost}`;",
      '}',
      '',
      '/**',
      " * The app's OWNING domain. Deployed apps are served on",
      ' * `<slug>.<domain>.<apps-domain>`, so when the first hostname label is this',
      " * app's slug the second label is the domain. VITE_APP_DOMAIN overrides (local",
      ' * dev); otherwise (in-OS preview, localhost) we honestly return null and the',
      ' * UI shows the signed-in user’s home domain instead.',
      ' */',
      'export function owningDomain(hostname: string = window.location.hostname): string | null {',
      "  const env = (import.meta.env.VITE_APP_DOMAIN as string | undefined) ?? '';",
      '  if (env) return env;',
      "  const labels = hostname.split('.');",
      '  if (labels.length >= 3 && labels[0] === APP_SLUG) return labels[1];',
      '  return null;',
      '}',
      '',
      "/** The OS page where THIS app's MCP connection lives (setup, tools, grants).",
      ' *  Deterministic: the OS registers the connection under principal `app-<slug>`. */',
      'export function mcpSetupUrl(): string {',
      "  return `${osBaseUrl()}/connections?focus=${encodeURIComponent('app-' + APP_SLUG)}`;",
      '}',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------- src/template/roles.ts --

function templateRolesTs(): ScaffoldFile {
  return {
    path: 'src/template/roles.ts',
    content: [
      '/**',
      ' * The OS role ladder, lowest → highest. Mirrors the OS session model — the app',
      ' * only READS the role the OS forwarded; it never assigns or stores roles.',
      ' * (Client-side gating is a courtesy: the OS enforces every read server-side.)',
      ' * FIXED scaffold (template/).',
      ' */',
      "export const ROLES = ['creator', 'builder', 'domain_admin', 'admin'] as const;",
      'export type Role = (typeof ROLES)[number];',
      '',
      '/** True when `role` ranks at or above `min` — always a floor, never an exact set. */',
      'export function roleAtLeast(role: string | null | undefined, min: Role): boolean {',
      "  const i = ROLES.indexOf((role ?? '') as Role);",
      '  return i >= 0 && i >= ROLES.indexOf(min);',
      '}',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------------- src/template/identity.tsx --

function templateIdentityTsx(): ScaffoldFile {
  return {
    path: 'src/template/identity.tsx',
    content: [
      "import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';",
      "import type { WhoAmI } from '@sovereign-os/app-sdk';",
      "import { osBaseUrl } from './app-meta.ts';",
      "import { createOsClient } from '../os.ts';",
      '',
      '/**',
      ' * IDENTITY IS DELEGATED TO THE OS. This app has no user store, no passwords and',
      ' * no sign-up: the signed-in user is whoever the Sovereign Agentic OS session',
      ' * says it is (`os.whoami()`, carried by the ambient OS session). When there is',
      ' * no session the app shows an honest signed-out screen linking back to the OS —',
      ' * it NEVER invents an anonymous or local user. FIXED scaffold (template/).',
      ' */',
      '',
      "export type OsUser = { id: string; username: string; role: string | null; domains: string[] };",
      '',
      'export type IdentityState =',
      "  | { phase: 'loading' }",
      "  | { phase: 'signed-out' }",
      "  | { phase: 'error'; message: string }",
      "  | { phase: 'ready'; user: OsUser };",
      '',
      "const IdentityContext = createContext<IdentityState>({ phase: 'loading' });",
      '',
      '/** The current OS identity, anywhere below <IdentityProvider>. */',
      'export function useIdentity(): IdentityState {',
      '  return useContext(IdentityContext);',
      '}',
      '',
      'function toOsUser(me: WhoAmI): OsUser | null {',
      '  const u = me?.user;',
      '  if (!u || u.id == null) return null;',
      '  return {',
      '    id: String(u.id),',
      '    username: String(u.username ?? u.id),',
      '    role: u.role != null ? String(u.role) : null,',
      '    domains: Array.isArray(u.domains) ? u.domains.map(String) : [],',
      '  };',
      '}',
      '',
      'const os = createOsClient();',
      '',
      '/** Resolves the OS session once on boot and provides it to the whole app. */',
      'export function IdentityProvider({ children }: { children: ReactNode }) {',
      "  const [state, setState] = useState<IdentityState>({ phase: 'loading' });",
      '  useEffect(() => {',
      '    let cancelled = false;',
      '    (async () => {',
      '      try {',
      '        const me = await os.whoami();',
      '        if (cancelled) return;',
      '        const user = toOsUser(me);',
      "        setState(user ? { phase: 'ready', user } : { phase: 'signed-out' });",
      '      } catch (e) {',
      '        if (cancelled) return;',
      '        // 401 → no OS session; anything else is an honest error, not a fake user.',
      "        const msg = e instanceof Error ? e.message : 'Unknown error';",
      "        const status = (e as { status?: number }).status;",
      "        setState(status === 401 ? { phase: 'signed-out' } : { phase: 'error', message: msg });",
      '      }',
      '    })();',
      '    return () => { cancelled = true; };',
      '  }, []);',
      '  return <IdentityContext.Provider value={state}>{children}</IdentityContext.Provider>;',
      '}',
      '',
      '/** The honest signed-out / unreachable screen — links back to the OS to sign in. */',
      'export function SignedOutScreen({ note }: { note?: string }) {',
      "  const osHome = osBaseUrl() || '/';",
      '  return (',
      '    <div className="sb-root" style={{ minHeight: \'100vh\', display: \'grid\', placeItems: \'center\', padding: 24 }}>',
      '      <div className="sb-panel-box" style={{ maxWidth: 460, padding: 28, textAlign: \'center\' }}>',
      '        <h1 style={{ margin: 0, fontSize: 20 }}>Not signed in via the OS</h1>',
      '        <p className="sb-muted" style={{ marginTop: 10 }}>',
      '          This app delegates identity to the <strong>Sovereign Agentic OS</strong> — it has',
      '          no accounts or passwords of its own. Sign in to the OS, then come back here.',
      '        </p>',
      '        {note ? <p className="sb-muted" style={{ fontSize: 12 }}>{note}</p> : null}',
      '        <a className="sb-btn" style={{ marginTop: 14, display: \'inline-block\' }} href={osHome}>',
      '          Open the Sovereign OS →',
      '        </a>',
      '      </div>',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------------- src/template/scope.ts --

function templateScopeTs(): ScaffoldFile {
  return {
    path: 'src/template/scope.ts',
    content: [
      "import type { OsUser } from './identity.tsx';",
      '',
      '/**',
      ' * DATA SCOPING — the OS My / Domain vocabulary, applied inside the app.',
      ' * FIXED scaffold (template/).',
      ' *',
      ' * Contract for every record this app stores or renders: it carries its OWNER',
      " * (an OS user id) and its OWNING DOMAIN. Reads through the OS SDK are already",
      ' * governed server-side (OPA + row-level security); these helpers keep the',
      " * app's OWN presentation and any app-local records to the same rule:",
      ' *',
      ' *   • My     — records the signed-in user owns.',
      " *   • Domain — records belonging to the app's owning domain.",
      ' *',
      ' * NEVER widen visibility client-side: filter down, stamp on write.',
      ' */',
      '',
      'export type Scoped = { owner: string; domain: string };',
      '',
      '/** Does the signed-in user own this record? (My) */',
      'export function isMine<T extends Scoped>(r: T, user: OsUser): boolean {',
      '  return r.owner === user.id;',
      '}',
      '',
      '/** Does this record belong to the given domain? (Domain) */',
      'export function inDomain<T extends Scoped>(r: T, domain: string | null): boolean {',
      '  return domain != null && r.domain === domain;',
      '}',
      '',
      '/** Only the records the signed-in user owns. */',
      'export function onlyMine<T extends Scoped>(rows: T[], user: OsUser): T[] {',
      '  return rows.filter((r) => isMine(r, user));',
      '}',
      '',
      "/** Only the records of the app's owning domain. */",
      'export function onlyDomain<T extends Scoped>(rows: T[], domain: string | null): T[] {',
      '  return rows.filter((r) => inDomain(r, domain));',
      '}',
      '',
      '/** What this user may see here: their OWN records plus their DOMAIN’s. */',
      'export function visibleTo<T extends Scoped>(rows: T[], user: OsUser, domain: string | null): T[] {',
      '  return rows.filter((r) => isMine(r, user) || inDomain(r, domain));',
      '}',
      '',
      '/** Stamp a new record with the writing user + owning domain (call on every write). */',
      "export function stamp<T extends object>(record: T, user: OsUser, domain: string | null): T & Scoped {",
      "  return { ...record, owner: user.id, domain: domain ?? user.domains[0] ?? '' };",
      '}',
      '',
    ].join('\n'),
  };
}

// ---------------------------------------------------- src/template/sections.tsx --

function templateSectionsTsx(): ScaffoldFile {
  return {
    path: 'src/template/sections.tsx',
    content: [
      "import type { ComponentType } from 'react';",
      "import Overview from './pages/Overview.tsx';",
      "import Workspace from '../core/pages/Workspace.tsx';",
      '',
      '/**',
      " * The app's left-nav SECTIONS — the single registry nav + routing read.",
      ' * FIXED scaffold (template/); epics ADD entries here pointing at their pages.',
      ' *',
      ' * EPICS ADD SECTIONS HERE. To add a feature section:',
      ' *   1. Create its page under src/epics/<epic>/<story>/<Name>.tsx (default-export',
      ' *      a component). Shared pages live in src/core/pages/.',
      ' *   2. Add ONE entry below — the sidebar and routing pick it up automatically.',
      ' *',
      ' * The Admin section (OS domain admins only) is appended automatically in',
      ' * src/template/shell.tsx — do not add it here.',
      ' */',
      '',
      'export type AppSection = {',
      '  id: string;',
      '  label: string;',
      '  /** Small leading glyph shown in the sidebar. */',
      '  icon: string;',
      '  page: ComponentType;',
      '};',
      '',
      'export const SECTIONS: AppSection[] = [',
      "  { id: 'overview', label: 'Overview', icon: '◇', page: Overview },",
      '  // Placeholder — the first built story replaces this with a real epic section:',
      "  { id: 'workspace', label: 'Workspace', icon: '▤', page: Workspace },",
      '];',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------- src/template/shell.tsx --

function templateShellTsx(): ScaffoldFile {
  return {
    path: 'src/template/shell.tsx',
    content: [
      "import { useState } from 'react';",
      "import { AppShell, Badge } from '@sovereign-os/ui';",
      "import { APP_NAME, mcpSetupUrl, owningDomain } from './app-meta.ts';",
      "import { SignedOutScreen, useIdentity } from './identity.tsx';",
      "import Admin from './pages/Admin.tsx';",
      "import { roleAtLeast } from './roles.ts';",
      "import { SECTIONS, type AppSection } from './sections.tsx';",
      '',
      '/**',
      ' * The app shell: OS-delegated identity gate → AppShell chrome → the current',
      ' * section. FIXED scaffold (template/). Sections live in template/sections.tsx',
      ' * (epics add entries there); the Admin section is appended here for OS domain',
      ' * admins only. Mounted by the thin src/App.tsx entrypoint.',
      ' */',
      'export default function Shell() {',
      '  const identity = useIdentity();',
      '  const [sectionId, setSectionId] = useState(SECTIONS[0].id);',
      '',
      "  if (identity.phase === 'loading') {",
      '    return (',
      '      <div className="sb-root" style={{ minHeight: \'100vh\', display: \'grid\', placeItems: \'center\' }}>',
      '        <span className="sb-muted">Checking your OS session…</span>',
      '      </div>',
      '    );',
      '  }',
      "  if (identity.phase === 'signed-out') return <SignedOutScreen />;",
      "  if (identity.phase === 'error') return <SignedOutScreen note={`The OS could not be reached: ${identity.message}`} />;",
      '',
      '  const user = identity.user;',
      '  // The owning domain from the deployed host; in preview/dev, the user’s home domain.',
      '  const domain = owningDomain() ?? user.domains[0] ?? null;',
      "  const isAppAdmin = roleAtLeast(user.role, 'domain_admin');",
      '',
      '  const sections: AppSection[] = [',
      '    ...SECTIONS,',
      "    ...(isAppAdmin ? [{ id: 'admin', label: 'Admin', icon: '⚙', page: Admin } satisfies AppSection] : []),",
      '  ];',
      '  const current = sections.find((s) => s.id === sectionId) ?? sections[0];',
      '  const Page = current.page;',
      '',
      '  const nav = sections.map((s) => ({',
      '    label: s.label,',
      '    icon: s.icon,',
      '    onClick: () => setSectionId(s.id),',
      '    active: s.id === current.id,',
      '  }));',
      '',
      '  const topbarRight = (',
      "    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>",
      '      {/* The owning domain — every read/write is scoped to it (template/scope.ts). */}',
      "      <Badge tone=\"muted\" title=\"This app's owning domain\">{domain ?? 'domain —'}</Badge>",
      '      <span className="sb-crumb" style={{ display: \'flex\', alignItems: \'center\', gap: 6 }}>',
      '        <strong>{user.username}</strong>',
      '        {user.role ? <Badge tone="muted">{user.role}</Badge> : null}',
      '      </span>',
      '      {/* This app’s MCP connection in the OS — agents call the app through it. */}',
      '      <a className="sb-btn sb-ghost sb-sm" href={mcpSetupUrl()} target="_blank" rel="noreferrer" title="Set up this app’s MCP connection in the OS">',
      '        MCP',
      '      </a>',
      '    </span>',
      '  );',
      '',
      '  return (',
      '    <AppShell',
      '      brand={APP_NAME}',
      '      brandSub="Powered by Sovereign OS"',
      '      nav={nav}',
      '      title={current.label}',
      '      crumb={APP_NAME}',
      '      topbarRight={topbarRight}',
      '      sidebarFooter={<>Signed in as <strong>{user.username}</strong> — via the OS</>}',
      '    >',
      '      <Page />',
      '    </AppShell>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// ----------------------------------------------- src/template/pages/Overview.tsx --

function templatePageOverviewTsx(): ScaffoldFile {
  return {
    path: 'src/template/pages/Overview.tsx',
    content: [
      "import { useEffect, useState } from 'react';",
      "import type { OsContext } from '@sovereign-os/app-sdk';",
      "import { Badge, Card, Section, Table } from '@sovereign-os/ui';",
      "import { owningDomain } from '../app-meta.ts';",
      "import { useIdentity } from '../identity.tsx';",
      "import { createOsClient } from '../../os.ts';",
      '',
      'type ContextItem = { id: string; name: string };',
      '',
      'const os = createOsClient();',
      '',
      '/**',
      ' * The starter Overview — who you are (from the OS) and the governed context this',
      ' * app has been granted. Honest loading / empty / error states; replace or extend',
      ' * as epics land real sections. FIXED scaffold (template/).',
      ' */',
      'export default function Overview() {',
      '  const identity = useIdentity();',
      '  const [ctx, setCtx] = useState<OsContext | null>(null);',
      '  const [error, setError] = useState<string | null>(null);',
      '',
      '  useEffect(() => {',
      '    let cancelled = false;',
      '    os.context()',
      '      .then((c) => { if (!cancelled) setCtx(c); })',
      "      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error'); });",
      '    return () => { cancelled = true; };',
      '  }, []);',
      '',
      "  const user = identity.phase === 'ready' ? identity.user : null;",
      '  const domain = owningDomain() ?? user?.domains[0] ?? null;',
      '  const datasets: ContextItem[] = ctx?.data ?? [];',
      '  const metrics: ContextItem[] = ctx?.metrics ?? [];',
      '  const knowledge: ContextItem[] = ctx?.knowledge ?? [];',
      '  const empty = datasets.length === 0 && metrics.length === 0 && knowledge.length === 0;',
      '',
      '  return (',
      '    <>',
      '      <Section title="Signed in via the OS">',
      '        <Card>',
      '          <h3>{user ? user.username : \'—\'} {user?.role ? <Badge tone="muted">{user.role}</Badge> : null}</h3>',
      '          <p className="sb-muted" style={{ marginTop: 6 }}>',
      "            Identity is delegated to the Sovereign Agentic OS — this app stores no accounts.",
      "            Owning domain: <strong>{domain ?? 'not determined here'}</strong>.",
      '          </p>',
      '        </Card>',
      '      </Section>',
      '',
      '      <Section title="Granted context" style={{ marginTop: 24 }}>',
      '        {error ? (',
      '          <Card><h3>OS unreachable</h3><p className="sb-muted">{error}</p></Card>',
      '        ) : ctx == null ? (',
      '          <Card><span className="sb-muted">Loading granted context…</span></Card>',
      '        ) : empty ? (',
      '          <Card>',
      '            <h3>Nothing granted yet</h3>',
      '            <p className="sb-muted">Ask a domain admin to grant datasets, metrics or knowledge to this app in the OS.</p>',
      '          </Card>',
      '        ) : (',
      '          <Table>',
      '            <thead><tr><th>Kind</th><th>Name</th></tr></thead>',
      '            <tbody>',
      "              {datasets.map((d) => (<tr key={'d-' + d.id}><td><Badge>Dataset</Badge></td><td className=\"sb-mono\">{d.name}</td></tr>))}",
      "              {metrics.map((m) => (<tr key={'m-' + m.id}><td><Badge tone=\"muted\">Metric</Badge></td><td className=\"sb-mono\">{m.name}</td></tr>))}",
      "              {knowledge.map((k) => (<tr key={'k-' + k.id}><td><Badge tone=\"muted\">Knowledge</Badge></td><td className=\"sb-mono\">{k.name}</td></tr>))}",
      '            </tbody>',
      '          </Table>',
      '        )}',
      '      </Section>',
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------- src/template/pages/Admin.tsx --

function templatePageAdminTsx(): ScaffoldFile {
  return {
    path: 'src/template/pages/Admin.tsx',
    content: [
      "import { useEffect, useState } from 'react';",
      "import { Badge, Card, Section, Table } from '@sovereign-os/ui';",
      "import { osBaseUrl } from '../app-meta.ts';",
      "import { useIdentity } from '../identity.tsx';",
      "import { roleAtLeast } from '../roles.ts';",
      '',
      '/** One OS user, as the OS directory reports them (read-only here). */',
      'type DirectoryUser = { id: string; name: string; role: string; domains: string[] };',
      '',
      'type Directory =',
      "  | { state: 'loading' }",
      "  | { state: 'ready'; users: DirectoryUser[] }",
      "  | { state: 'unavailable'; reason: string };",
      '',
      '/**',
      ' * The Admin section — OS domain_admin / admin only (shell.tsx gates the nav; this',
      ' * page also self-guards). User management STAYS in the OS: this list is read-only,',
      ' * fetched from the governed OS directory as the signed-in user. FIXED scaffold.',
      ' */',
      'export default function Admin() {',
      '  const identity = useIdentity();',
      "  const [dir, setDir] = useState<Directory>({ state: 'loading' });",
      '',
      '  useEffect(() => {',
      '    let cancelled = false;',
      '    (async () => {',
      '      try {',
      '        const res = await fetch(`${osBaseUrl()}/api/users/domain`, {',
      "          credentials: 'include',",
      "          headers: { accept: 'application/json' },",
      "          cache: 'no-store',",
      '        });',
      '        if (cancelled) return;',
      '        if (!res.ok) {',
      '          setDir({',
      "            state: 'unavailable',",
      '            reason: res.status === 401 || res.status === 403',
      "              ? 'The OS did not share the user directory with your role.'",
      '              : `The OS user directory answered ${res.status}.`,',
      '          });',
      '          return;',
      '        }',
      '        const body = (await res.json()) as { users?: DirectoryUser[] };',
      "        setDir({ state: 'ready', users: body.users ?? [] });",
      '      } catch (e) {',
      "        if (!cancelled) setDir({ state: 'unavailable', reason: e instanceof Error ? e.message : 'OS unreachable' });",
      '      }',
      '    })();',
      '    return () => { cancelled = true; };',
      '  }, []);',
      '',
      "  const role = identity.phase === 'ready' ? identity.user.role : null;",
      "  if (!roleAtLeast(role, 'domain_admin')) {",
      '    return (',
      '      <Section title="Admin">',
      '        <Card><p className="sb-muted">The admin area is for OS domain admins. Your OS role does not include it.</p></Card>',
      '      </Section>',
      '    );',
      '  }',
      '',
      '  return (',
      '    <>',
      '      <Section title="App settings">',
      '        <Card>',
      '          <h3>Settings</h3>',
      '          <p className="sb-muted">',
      '            No app settings yet — epics add them here. Deployment, grants and lifecycle',
      '            are governed in the OS Software tab, not in the app.',
      '          </p>',
      '        </Card>',
      '      </Section>',
      '',
      '      <Section title="Who can access this app" style={{ marginTop: 24 }}>',
      '        <p className="sb-muted" style={{ marginTop: 0 }}>',
      '          Read-only, from the OS identity model. Users are managed in the Sovereign OS',
      '          (Admin → Users) — never in the app.',
      '        </p>',
      "        {dir.state === 'loading' ? (",
      '          <Card><span className="sb-muted">Loading the OS user directory…</span></Card>',
      "        ) : dir.state === 'unavailable' ? (",
      '          <Card><h3>Directory unavailable</h3><p className="sb-muted">{dir.reason} Manage users in the Sovereign OS.</p></Card>',
      '        ) : dir.users.length === 0 ? (',
      '          <Card><p className="sb-muted">No users visible to you in this domain.</p></Card>',
      '        ) : (',
      '          <Table>',
      '            <thead><tr><th>User</th><th>OS role</th><th>Domains</th></tr></thead>',
      '            <tbody>',
      '              {dir.users.map((u) => (',
      '                <tr key={u.id}>',
      '                  <td><strong>{u.name || u.id}</strong> <span className="sb-mono sb-muted">{u.id}</span></td>',
      '                  <td><Badge tone="muted">{u.role}</Badge></td>',
      "                  <td className=\"sb-mono\">{u.domains.join(', ')}</td>",
      '                </tr>',
      '              ))}',
      '            </tbody>',
      '          </Table>',
      '        )}',
      '      </Section>',
      '    </>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// ---------------------------------------------------------- src/core/store.ts --

function coreStoreTs(): ScaffoldFile {
  return {
    path: 'src/core/store.ts',
    content: [
      "import { createOsClient } from '../os.ts';",
      '',
      '/**',
      ' * CORE shared data plane. Overarching functionality + SHARED backend/data code that',
      ' * more than one epic reuses lives here. The default Sovereign app uses the GOVERNED',
      ' * DATA PLANE — the OS SDK, NOT Supabase or a custom backend. All governed reads go',
      ' * through this single client so every call runs as the signed-in user (OPA + RLS/DLS).',
      ' *',
      ' * Per-story data belongs under src/epics/<epic>/<story>/; promote a helper here only',
      ' * when it is genuinely shared across stories.',
      ' */',
      '',
      '/** The one governed OS client for shared reads (whoami, context, datasets, metrics…). */',
      'export const os = createOsClient();',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------- src/core/pages/Workspace.tsx --

function corePageWorkspaceTsx(): ScaffoldFile {
  return {
    path: 'src/core/pages/Workspace.tsx',
    content: [
      "import { Card, Section } from '@sovereign-os/ui';",
      '',
      '/**',
      ' * Placeholder shared section (core/) — the first built story replaces this with a',
      ' * real page under src/epics/<epic>/<story>/. Keep the pattern: one page per section,',
      ' * registered in src/template/sections.tsx.',
      ' */',
      'export default function Workspace() {',
      '  return (',
      '    <Section title="Workspace">',
      '      <Card>',
      '        <h3>Waiting for its first story</h3>',
      '        <p className="sb-muted">',
      '          This section is a placeholder. Design the backlog in the OS Software tab,',
      '          then build it story by story — the Build assistant adds real pages under',
      '          src/epics/&lt;epic&gt;/&lt;story&gt;/.',
      '        </p>',
      '      </Card>',
      '    </Section>',
      '  );',
      '}',
      '',
    ].join('\n'),
  };
}

// ------------------------------------------------------------ src/epics/README.md --

function epicsReadme(): ScaffoldFile {
  return {
    path: 'src/epics/README.md',
    content: [
      '# epics/',
      '',
      'Empty at scaffold time. The Build stage fills this in, mirroring the epic/story spec:',
      '',
      '```',
      'epics/',
      '  <epicKey>/',
      '    general/            epic-wide shared code (used by ≥2 stories of the epic)',
      '    <storyKey>/         that story\'s feature code + its own backend/data',
      '```',
      '',
      'Each built story adds its page here and registers ONE entry in',
      '`src/template/sections.tsx`. Code shared across epics lives in `src/core/`; the',
      'fixed scaffold (identity, roles, scope, layout, admin) lives in `src/template/` and',
      'must not be removed.',
      '',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------- app.yaml --

function appYaml(name: string, slug: string): ScaffoldFile {
  return {
    path: 'app.yaml',
    content: [
      'apiVersion: software.sovereign-os/v1',
      'kind: App',
      `name: '${name}'`,
      'owner: gitea_admin',
      `description: '${name} — a Sovereign standard app built in the Software tab.'`,
      '# Declare the surface so the monitor shows the UI link from day one.',
      'surface: ui',
      'declares:',
      '  connections: []',
      '  data: []',
      '  knowledge: []',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------------------- .app/decisions.md --

function decisionsMd(name: string): ScaffoldFile {
  return {
    path: '.app/decisions.md',
    content: [
      `# ${name} — design decisions`,
      '',
      'Captured under the app and versioned in git.',
      '',
      '## Stack',
      '',
      '- **Frontend:** Vite + React + TypeScript + Tailwind CSS (SPA, nginx on 8080)',
      '- **Design system:** `@sovereign-os/ui` — OS theme + `AppShell` + primitives (vendored)',
      '- **OS integration:** `@sovereign-os/app-sdk` — `os.whoami()`, `os.context()`, governed queries',
      '',
      '## Code structure',
      '',
      '- Code MIRRORS the epic/story spec: `src/template/` (fixed scaffold), `src/core/`',
      '  (shared functionality + governed data plane), `src/epics/<epic>/<story>/` (features).',
      '- `src/main.tsx` + `src/App.tsx` are THIN entrypoints only — real logic lives in the',
      '  structured folders above.',
      '',
      '## Identity & tenancy',
      '',
      '- Identity is DELEGATED to the OS: `os.whoami()` is the only source of the signed-in',
      '  user; there are no local accounts or passwords (src/template/identity.tsx).',
      '- The owning domain comes from the deployed host (`<slug>.<domain>.<apps-domain>`,',
      '  src/template/app-meta.ts); every record is scoped by owner + domain (src/template/scope.ts).',
      '- The in-app Admin area (OS domain admins) is read-only over the OS identity model.',
      '',
    ].join('\n'),
  };
}

// -------------------------------------------------------------------- README.md --

function readmeMd(name: string, slug: string): ScaffoldFile {
  return { path: 'README.md', content: sovereignAppGuide(name, slug) };
}

/**
 * The skeleton guide — seeded as README.md AND used as the app's `docs`, so the
 * Build assistant reads the same contract the repo documents.
 */
export function sovereignAppGuide(name: string, slug: string): string {
  return [
    `# ${name}`,
    '',
    'A **Sovereign standard app** — scaffolded by the Sovereign Agentic OS Software tab.',
    'It already behaves like an OS app: OS chrome, OS-delegated identity, domain-scoped',
    'data, an admin area and an MCP connection. Epics add business features on top.',
    '',
    '## Code structure (mirrors the epic/story spec)',
    '',
    'Real logic lives in structured folders; the Vite entrypoints stay thin.',
    '',
    '| Folder | Role |',
    '|---|---|',
    '| `src/template/` | The FIXED scaffold — identity, roles, scope, app-meta, the AppShell layout (`shell.tsx`), the section registry and the Admin/Overview pages. Do not remove; a developer overrides it only deliberately. |',
    '| `src/core/` | Overarching custom functionality + SHARED data/store code (the governed data plane, `store.ts`) and shared pages. |',
    '| `src/epics/<epic>/general/` | Epic-wide shared code (used by ≥2 stories of the epic). |',
    '| `src/epics/<epic>/<story>/` | That story\'s feature code + its own backend/data. |',
    '| `src/App.tsx`, `src/main.tsx` | THIN entrypoints (Vite\'s router layer) — they only mount the template Shell. No business logic here. |',
    '',
    '## The skeleton (do not remove; extend)',
    '',
    '| File | Role |',
    '|---|---|',
    '| `src/main.tsx` | Boots React and mounts `src/App.tsx`. Thin. |',
    '| `src/App.tsx` | Wires the template Shell inside the OS identity provider. Thin. |',
    '| `src/template/shell.tsx` | Identity gate → `AppShell` chrome → current section. Appends Admin for OS domain admins. |',
    '| `src/template/sections.tsx` | **The section registry — epics add nav entries here.** One page per section. |',
    '| `src/template/pages/Overview.tsx` | Starter page: the signed-in OS user + granted context. |',
    '| `src/core/pages/Workspace.tsx` | Placeholder — replace with the first real feature section under `src/epics/`. |',
    '| `src/template/pages/Admin.tsx` | Admin (OS `domain_admin`/`admin` only): settings placeholder + read-only OS user list. |',
    '| `src/template/identity.tsx` | OS-delegated identity: `os.whoami()`, signed-out screen. **No local auth, ever.** |',
    '| `src/template/scope.ts` | My / Domain data-scoping helpers — every record carries `owner` + `domain`. |',
    '| `src/template/roles.ts` | The OS role ladder + `roleAtLeast` (a floor check, never an exact set). |',
    '| `src/template/app-meta.ts` | App name/slug, OS base URL, owning-domain derivation, MCP setup link. |',
    '| `src/core/store.ts` | The shared governed OS client (`@sovereign-os/app-sdk`) — governed reads as the signed-in user. |',
    '| `src/os.ts` | The `@sovereign-os/app-sdk` client factory (governed OS calls). |',
    '',
    '## How epics add features',
    '',
    '1. Create the story page under `src/epics/<epic>/<story>/<Feature>.tsx` (default-export',
    '   a React component; use the `@sovereign-os/ui` primitives — `Section`, `Card`, `Table`,',
    '   `Badge`, `Button`). Epic-wide shared code goes in `src/epics/<epic>/general/`.',
    '2. Register it in `src/template/sections.tsx` — nav + routing pick it up automatically.',
    '3. Read data ONLY through the OS SDK (`src/core/store.ts` / `src/os.ts`) — governed, as',
    '   the signed-in user. Promote shared helpers to `src/core/`.',
    '4. Scope every app-local record with `src/template/scope.ts` (`stamp` on write, `visibleTo` on read).',
    '5. Keep `src/App.tsx` / `src/main.tsx` thin and `src/template/` intact.',
    '',
    '## The identity contract',
    '',
    '- The signed-in user is whatever the OS session says (`os.whoami()`), carried by the',
    '  ambient OS session (same-origin in the OS preview; the platform forwards it for',
    '  deployed apps). When absent, render `SignedOutScreen` — never an invented user.',
    '- Roles and users are managed in the OS. The app only READS identity; the in-app',
    '  Admin list is read-only over `GET /api/users/domain` (OS domain admins and up).',
    '',
    '## MCP',
    '',
    `This app is exposed to agents as governed MCP tools under the principal \`app-${slug}\`.`,
    'The top-bar **MCP** button links to the connection in the OS Connections tab',
    `(\`/connections?focus=app-${slug}\`) where tools and grants are managed.`,
    '',
    '## Development',
    '',
    '```sh',
    'npm install',
    'echo "VITE_OS_API=http://localhost:3000" > .env.local   # the OS base URL',
    'npm run dev',
    '```',
    '',
    'CI (`.forgejo/workflows/ci.yml`) builds the multi-stage Docker image (Vite build →',
    `nginx on 8080); the OS runner serves it at \`${slug}.<domain>.<apps-domain>\`.`,
    '',
  ].join('\n');
}

/** The canonical file paths produced by this template (for test assertions). */
export const SOVEREIGN_APP_EXPECTED_PATHS = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'tailwind.config.js',
  'postcss.config.js',
  'src/index.css',
  'Dockerfile',
  'nginx.conf',
  '.forgejo/workflows/ci.yml',
  'openapi.yaml',
  'src/os.ts',
  'src/vite-env.d.ts',
  'src/main.tsx',
  'src/App.tsx',
  'src/template/app-meta.ts',
  'src/template/roles.ts',
  'src/template/identity.tsx',
  'src/template/scope.ts',
  'src/template/sections.tsx',
  'src/template/shell.tsx',
  'src/template/pages/Overview.tsx',
  'src/template/pages/Admin.tsx',
  'src/core/store.ts',
  'src/core/pages/Workspace.tsx',
  'src/epics/README.md',
  'app.yaml',
  '.app/decisions.md',
  'README.md',
];
