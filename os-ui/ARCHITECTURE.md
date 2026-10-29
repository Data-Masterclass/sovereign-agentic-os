<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# os-ui architecture

One Next.js application: the OS shell, every tab's surfaces, the API routes behind
them, and the MCP server. The UI and MCP are two transports over the **same**
governed code — the MCP endpoint is a front door, never a back door.

## The shape

```
core/      The kernel. Everything every tab depends on; it never imports a tab.
  kernel/    session · auth · config · roles · tabs · artifacts · scopes · lifecycle
  policy/    OPA client, the approvals queue, governance effects (the write spine)
  mcp/       the ONE dispatcher (handleRpc), the tool registry, token minting
  runtime/   the agent/assistant loop, LiteLLM model calls, tool dispatch
  infra/     external-service clients + the OpenSearch mirror (os-* indexes)
  auth/      OAuth app + token plumbing for Connections
  ui/        the app shell: Sidebar, PageHeader, AuthGate, OsAssistant, theme
  app-sdk/   the client SDK vendored INTO generated apps  (keep imports relative)
  app-ui/    the UI package vendored INTO generated apps  (keep imports relative)
  guides/    the cross-cutting guides (overview, how-to-use, governance)
  manifest.ts  the TabManifest contract

tabs/      One folder per tab. A tab imports @core/* and itself — never another tab.
  <tab>/
    manifest.ts   feature key · nav entry · routes · api · mcpTools · policies · services
    lib/          the tab's domain logic
    ui/           the tab's React components
    mcp/          the tab's MCP tool bundle
    guide.md      the in-app guide          context.md  the model-facing context
    *.test.ts     next to the code they test

app/       The Next.js App Router tree. Routes MUST live here, so pages stay put and
           import from @core/* and @tabs/*. Nothing but routing belongs in app/.
```

Path aliases: `@core/*` → `core/*`, `@tabs/*` → `tabs/*` (tsconfig + the test loader).

## The 13 tabs

| Group | Tabs |
|---|---|
| Entry | Home · MCP · About / Licenses |
| Context | Data · Metrics · Files · Knowledge |
| Build | **Workflows** · Agents · Dashboards · Software |
| Manage | Connections · Governance · Monitoring · Admin |

A tab declares the deployed services it needs in its manifest. If a service is
disabled in the chart, the tab is absent from the navigation rather than broken;
`OS_ENABLED_TABS` gates the same set at runtime (`core/kernel/tabs.ts`).

## The rules, and how they are enforced

`scripts/check-structure.mjs` (in CI):

1. `components/` holds upstream material only — licence and pin, nothing of ours.
2. A tab imports `@core/*` and its own folder. Cross-tab needs go through the kernel.
3. The kernel never imports a tab.
4. Every tab has a `manifest.ts`.
5. Every source file carries a `FEATURE` / `USER STORY` / `ARCHITECTURE` header.

Rules 2, 3 and 5 carry a real backlog inherited from v1, so the checker is a
**ratchet**: it fails when a count grows, never because the backlog still exists.
`scripts/structure-baseline.json` records where we are; shrink it as it is paid down.

## How a write happens

```
UI page  ─┐
          ├─> app/api/<route>  ─> @tabs/<tab>/lib  ─> @core/policy (authorize)
MCP call ─┘        or @core/mcp/handleRpc                 │
                                                          ├─ allowed  -> effect + trace
                                                          └─ held     -> approvals queue
                                                                          (Governance tab)
```

Authorisation is OPA, fail-closed, and runs as the **acting user** — an agent can
exceed neither its own grants nor the rights of whoever runs it. Model calls go
through LiteLLM; runs are traced to Langfuse.

## Two things that will bite you

- **`core/app-ui` and `core/app-sdk` are vendored verbatim into generated apps.**
  Their own imports must stay **relative**; an `@core/*` alias does not exist inside
  a generated tree, and aliasing them silently degrades the vendored package's types
  to `any`.
- **Scaffolds hold generated app source inside template literals.** Import-looking
  strings in there belong to the generated app, not to os-ui — never rewrite them.

## Generated documentation

`node scripts/build-docs.mjs` renders `docs/site/index.html` — every folder and file,
taking its prose from the file headers, the tab manifests and the component pins, so
it cannot drift. CI fails if the committed page is stale.
