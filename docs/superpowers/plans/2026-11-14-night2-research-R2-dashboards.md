> Research report, night run 2, read-only audit at main `31c0fc90`.

# R2 — Dashboards with Superset-class power, fully inside the OS

Research agent **R2**, night-2 programme, 2026-11-13.
Repo audited: `/Users/alex/Documents/Claude/Projects/Data Masterclass Apps/sovereign-os-stack`, branch `main`, at `31c0fc90`.
Read-only on the repo. Every `path:line` below is `os-ui/`-relative unless stated.

**Owner's ask (verbatim):** "Building dashboards on top of the DBT metrics and data products that have a similar power as Superset (you can shamelessly copy code that makes sense to copy to save time from superset as it is open source but fully integrate it into the OS - whatever is allowed under license, you can also leverage any alternative open source dashboard tool code that can help us to build a lean custom fully integrated version as long as it is allowed)."

---

## 0. Executive summary

- **Licence:** Apache-2.0 → Apache-2.0 is the easy case. We may copy Superset source verbatim; we must keep each file's licence header + copyright, state that we changed it, and propagate Superset's NOTICE. **The repo already does the NOTICE half** (`NOTICE` lines 19-27, `licenses/notices/Apache-Superset-NOTICE.txt`) because Superset is bundled *today* (`licenses/components.tsv:33`). So vendoring source only *narrows* our obligations relative to the status quo.
- **Recommended option: (B+) — build fresh on ECharts with a Superset-inspired form-data model, and vendor four small, backend-free slices of Superset source: (1) `plugins/plugin-chart-echarts/src/**/transformProps.ts` + `src/utils/series.ts`, (2) `packages/superset-ui-core/src/{time-format,number-format,currency-format,time-comparison}`, (3) the `packages/superset-ui-chart-controls` taxonomy as *data*, (4) `src/dashboard/util/` — the pure `position_json` layout algebra.** Do **not** `npm i @superset-ui/*` — the packages are **frozen at 2024-12-10** and peer on **React ^16.13.1** against our React 19 (§2.2) — and do **not** bundle the Superset app (option C, which is exactly what v2-lean removes). For the grid substrate use **`react-grid-layout@2.3.0` (MIT, peer `react >= 16.3.0`)**; Superset's own DnD is `react-dnd@11`, dormant since 2022.
- **MUST-list effort: ≈ 41.5 engineer-days** (§4.3). The three biggest items are layout+tabs (3.5 d, now mostly porting), the native filter bar (4 d) and the pivot table (4 d).
- **Biggest single gap vs Superset is not chart types.** It is: a dashboard is bound to **one** view (`DashboardSpec.view`, `tabs/dashboards/lib/model.ts:84`), there is **no layout model** beyond a 12-column width hint (`GridPos`, `model.ts:36` — `x`/`y`/`h` are written as `{x:0,y:0,w,h:1}` and ignored), **no tabs/markdown/header tiles**, **no dashboard-level time range**, **no pivot/heatmap/funnel/map**, **no PNG export**, **no dashboard-as-code in git**, and **no `update_dashboard`/`add_chart`/`render_dashboard_data` MCP tools**.

---

## 1. What "Superset power" means, concretely

Priority for the OS: **MUST** = must exist for the claim "comparable to Superset" to be honest · **SHOULD** = expected by a Superset user, second wave · **LATER** = real Superset feature we deliberately defer.

### 1.1 Chart types

| Superset capability | OS priority | Notes / OS today |
|---|---|---|
| Table (raw + aggregate, sort, pagination, totals, conditional formatting) | **MUST** | partial: `vizType: 'table'` renders a plain HTML table + CSV (`ui/PanelChart.tsx`), no sort/paging/totals |
| Big Number, Big Number with Trendline | **MUST** | partial: `big_number` / `big_number_total` exist, **no trendline, no subheader, no comparison vs prior period** |
| Time-series Line / Area / Bar (incl. stacked, multi-measure) | **MUST** | exists (`line`/`area`/`bar`, multi-measure merge in `lib/build/panel-query.ts:143-179`); no stacking control, no dual axis |
| Bar chart (categorical, grouped/stacked, horizontal) | **MUST** | exists, vertical only, grouped only |
| Pie / Donut | **MUST** | exists (`PanelChart.tsx:100-106`) |
| Pivot Table v2 (row+column groupings, subtotals, % of total) | **MUST** | **absent** — this is the single most-missed Superset chart for data-product owners |
| Heatmap | **SHOULD** | absent |
| Funnel | **SHOULD** | absent |
| Gauge | **SHOULD** | absent |
| Scatter / Bubble | **SHOULD** | absent |
| Box plot, Waterfall, Sankey, Treemap, Sunburst, Radar, Graph/network | **LATER** | absent. `@xyflow/react` already in deps covers network/graph needs elsewhere |
| World/Country map, deck.gl geospatial | **LATER** | absent; needs geo columns we do not model yet |
| Handlebars / custom-HTML viz | **LATER** (prefer the Software tab's app runtime for this) | absent |
| Markdown / header / divider tile | **MUST** | absent — no non-chart tile type exists at all |

### 1.2 Dashboard-level interaction

| Superset capability | OS priority | Notes / OS today |
|---|---|---|
| **Native filters** bar (value/numerical-range/time/time-grain/time-column filters, with dependencies, scoping per chart, default values) | **MUST** | partial: cross-filter *chips* only, seeded from `DashboardSpec.filters`, equality-only, session state (`ui/DashboardGrid.tsx:32-64`, `seedFilters` at `:38`). No filter *bar*, no range/time filter, no per-chart scoping, no dependent filters |
| **Cross-filtering** (click a chart → filters the whole dashboard) | **MUST** | exists, chip-shaped and equality-only (`DashboardGrid.tsx:50-64`, `withFilters` at `:55`) — and correctly pushed into the governed WHERE, not a client re-slice |
| **Drill to detail / drill by** | **MUST** | exists and is good: `ui/DrillDrawer.tsx` re-runs the *governed* query with the clicked filter pushed into SQL (`DrillDrawer.tsx:14-21`), never a client-side re-slice |
| Dashboard **time range** + **time grain** control (one control, all charts) | **MUST** | partial: per-panel `timeGrain` (`model.ts:56`) plus a viewer grain switcher over `['day','week','month','quarter','year']` (`DashboardGrid.tsx:26`). **No dashboard-level time *range*** (no "last 28 days", no custom since/until) |
| Time comparison / "% change vs previous period" | **SHOULD** | absent |
| **Layout grid**: free drag+resize, rows, columns, **tabs**, markdown, header, divider; `position_json` tree | **MUST** (grid+resize+tabs+markdown) | **absent.** `GridPos` exists in the type (`model.ts:36`) but only `w` is honoured — `spanOf` clamps `gridPos.w` to 1-12 (`DashboardGrid.tsx:30`) and `PanelBuilder` always writes `{x:0,y:0,w,h:1}` (`ui/PanelBuilder.tsx:175`). It is a flow layout with width hints, not a grid |
| Chart **Explore** view: metric/dimension pickers, adhoc metrics (SIMPLE + SQL), adhoc filters, series limit, sort, row limit, time compare, viz-type switcher, "View query", "Results" pane | **MUST** (minus adhoc SQL) | partial: `ui/PanelBuilder.tsx` gives metric(s) × one dimension × one time dimension × grain × width × viz type (`PanelBuilder.tsx:113-177`). Missing: >1 group-by dimension, adhoc metrics, non-equality filters, series/row limit, sort, "View query" (the SQL *is* returned on the wire — `PanelQueryResult.sql`, `lib/build/panel-query.ts:44` — but the panel UI does not show it) |
| **SQL Lab** (ad-hoc SQL, schema browser, query history, saved queries, "explore from query") | **SHOULD** (the OS already has a governed equivalent) | the Data tab's `ExplorePanel` + `queryRun` (`core/infra/governed.ts:117`) + the `query_data` MCP tool are the OS's SQL surface; `dropToSql` (`tabs/metrics/lib/explorer.ts:77`) is the analyst escape hatch. **Saved queries + query history: absent** |
| Saved queries | **SHOULD** | absent |
| **RLS** (per-role row filters) | **MUST** — *already stronger than Superset's* | Superset's RLS is a Superset-side clause list. The OS pushes the **viewer's delegated identity to Trino** per panel: `propagate(token)` asserts a user-delegated token (`lib/build/panel-query.ts:114`, `tabs/data/lib/identity.ts:132`), so two viewers of the same certified dashboard see different rows. Keep this; never cache across principals |
| Dashboard/chart **embedding** (iframe + guest token, `@superset-ui/embedded-sdk`) | **SHOULD** | no iframe/guest-token path (deliberately removed — `app/api/dashboards/connect-info/route.ts:11-16` says "there is no external BI console"). The OS-native answer is embedding a dashboard **inside a Software-tab app**; `ChartExplorerRenderer` already proves the renderer runs there (`tabs/software/ui/appspec/ChartExplorerRenderer.tsx:7-17`) |
| **Alerts & Reports** (scheduled screenshot/CSV email+Slack, alert on a SQL condition) | **SHOULD** | partial + honest: `lib/reports.ts` decides what is due, `lib/delivery.ts:24` ships **in-app only** and documents that email/Slack "were UI fiction". Metric alerts live in `tabs/metrics/lib/alerts.ts`. No PDF/PNG snapshot is actually rendered (`reports.ts:8-9` admits the render is "injected at the route") |
| **CSV export** (chart + dashboard) | **MUST** | partial: per-panel CSV of the rendered rows (`PanelChart.tsx:44-60`), table panels only. No dashboard-wide CSV, no Excel |
| **PNG/PDF export / screenshot** | **SHOULD** | absent (though `jspdf` + `jspdf-autotable` are already dependencies — `package.json`) |
| Annotations + annotation layers (formula, interval, event, from another chart) | **LATER** | absent |
| Theming / CSS templates | **SHOULD** (OS design system wins) | the OS already themes ECharts from CSS custom properties (`PanelChart.tsx:35-40`) — this is *better* integration than Superset's CSS templates. Keep; don't vendor Superset theming |
| Dashboard properties: owners, certification, tags, cache timeout | **MUST** (owners/certification) | exists via the OS ladder: `DashTier` personal→domain→marketplace with role gates (`lib/governance.ts:18-51`), folders (`lib/store.ts:283`), version history + restore (`lib/store.ts:325,335`), archive (`:269`). Tags: absent. Per-dashboard cache timeout: absent (no cache at all) |
| Dashboard **export/import** (ZIP of YAML) | **MUST** — as **git**, not a ZIP | absent. See §4.4 |
| Import a Superset dashboard export ZIP (uuid-keyed, `version: 1.0.0`) as a migration path | **LATER** — cheap interop, needs no vendored UI (§2.5) | absent |
| Chart "favourite", recently-viewed, search/filter the dashboard list | **SHOULD** | folder tree + My/Domain/Company groups exist (`lib/store.ts:137-149`); no favourites |
| Query **caching** | **SHOULD** | **absent, and must be principal-keyed when added** (see risk R7) |
| Row limit / query cost guards | **MUST** | `ExploreSpec.limit` exists (`tabs/metrics/lib/explorer.ts:21`) but no panel-level default limit and no cost cap on a 30-panel dashboard |

---

## 2. Licence due diligence

### 2.1 Apache Superset — Apache-2.0, and what copying actually obliges

Licence: <https://github.com/apache/superset/blob/master/LICENSE.txt> · NOTICE: <https://github.com/apache/superset/blob/master/NOTICE> · licence text: <https://www.apache.org/licenses/LICENSE-2.0.txt>.

Our repo is Apache-2.0 (`LICENSE`), so this is the compatible-by-construction case: **we may copy Superset source into our tree, modify it, and redistribute it under our own Apache-2.0 release**, with no copyleft reach-back. The obligations are §4 of the licence — four chores, not constraints:

- **§4(a)** "give any other recipients … a copy of this License" → ship the full Apache-2.0 text. Already present: `LICENSE`, `licenses/Apache-2.0.txt`.
- **§4(b)** "cause any modified files to carry prominent notices stating that You changed the files" → a change note on **every** Superset file we edit, e.g. `Modified from apache/superset <path> @ <sha>; changes: …`. **The clause most often missed.**
- **§4(c)** "retain, in the Source form …, all copyright, patent, trademark, and attribution notices from the Source form" → keep the ASF header block intact at the top of each copied file; never replace it with ours. ASF's own source-header policy says the same from the other direction: "Do not modify or remove any copyright notices or licenses within third-party works" and "Do not add the standard Apache License header to the top of third-party source files" (<https://www.apache.org/legal/src-headers.html>).
- **§4(d)** "any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file" → our NOTICE must **append** Superset's attribution block, not replace it. **Already done:** `NOTICE` lines 19-27 reproduce it verbatim and `licenses/notices/Apache-Superset-NOTICE.txt` bundles the file — because Superset is a bundled component *today* (`licenses/components.tsv:33`, `THIRD-PARTY-LICENSES.md:104`).
- **§6 Trademarks** — the grant excludes trade names and marks "except as required for reasonable and customary use in describing the origin of the Work". So: "includes code derived from Apache Superset" is fine; branding the feature "Superset", shipping the Superset or ASF feather logo, or a confusing domain is not. Superset's own footer: "Apache Superset, Apache, Superset, the Superset logo, and the Apache feather logo are either registered trademarks or trademarks of The Apache Software Foundation." Policy: <https://www.apache.org/foundation/marks/>, <https://www.apache.org/foundation/marks/pmcs>, <https://www.apache.org/foundation/marks/faq/>. Our `NOTICE` lines 5-7, `TRADEMARKS.md` and `core/kernel/licenses.ts:88` already carry the disclaimer.

**Net effect: vendoring Superset *source* narrows our obligations** relative to the status quo, in which we ship the whole Flask app as a Helm chart.

### 2.2 The npm `@superset-ui/*` packages — Apache-2.0, but frozen and React-16-pinned

Every chart/control package was last published **2024-12-10** and the in-repo `package.json` versions were never bumped past the published ones, despite ~2 years of source change. None is flagged `deprecated` on npm — so `npm i` silently installs a React-16 tree with no warning. (Verified directly with `npm view` on 2026-11-13, and cross-checked by a second pass.)

| Package | npm latest | Licence | Last published | Size | React peer |
|---|---|---|---|---|---|
| `@superset-ui/core` | **0.20.4** | Apache-2.0 | **2024-12-10** | 2.80 MB / 1 498 files | **`^16.13.1`** |
| `@superset-ui/chart-controls` | 0.20.3 | Apache-2.0 | 2024-12-10 | 1.26 MB / 488 | `^16.13.1` + `antd 4.10.3`, `@ant-design/icons ^5`, `@emotion/react ^11`, `ace-builds`, `react-ace`, `brace` |
| `@superset-ui/plugin-chart-echarts` | 0.20.3 | Apache-2.0 | 2024-12-10 | **13.87 MB / 1 152** | `^16.13.1` |
| `@superset-ui/plugin-chart-table` | 0.20.3 | Apache-2.0 | 2024-12-10 | 1.70 MB / 186 | `^16.13.1` + `match-sorter` |
| `@superset-ui/plugin-chart-pivot-table` | 0.20.3 | Apache-2.0 | 2024-12-10 | 1.65 MB / 86 | `^16.13.1` |
| `@superset-ui/plugin-chart-handlebars` | 0.20.3 | Apache-2.0 | 2024-12-10 | — | `^16.13.1` + `ace-builds`, `moment` |
| `@superset-ui/switchboard` | 0.20.3 | Apache-2.0 | 2024-12-10 | 0.11 MB / 17 | **none** (framework-free postMessage RPC) |
| `@superset-ui/embedded-sdk` | **0.4.0** | Apache-2.0 | **2026-06-18** — the only live one | 0.13 MB / 22 | none |
| `@apache-superset/core` (the new split-out core) | 0.1.0 | Apache-2.0 | 2026-05-11 | — | — |
| `@superset-ui/legacy-plugin-chart-*` (13 of them) | 0.20.3 | Apache-2.0 | 2024-12-10 | — | `^16` |
| `@superset-ui/legacy-plugin-chart-sunburst` / `-treemap`, `preset-chart-xy` | 2.1.0 | Apache-2.0 | **2023-04-18** (dead) | — | — |

`@superset-ui/core@0.20.4` peers, verbatim: `react ^16.13.1`, `react-loadable ^5.5.0`, `tinycolor2`, `@emotion/cache ^11.4.0`, `@emotion/react ^11.4.1`, `@emotion/styled ^11.3.0`, plus `@testing-library/*` as *runtime peers*.

**npm vs the monorepo today** — the published line is two years behind on every axis:

| | npm 0.20.3/0.20.4 (Dec 2024) | `apache/superset@master` |
|---|---|---|
| React peer | `^16.13.1` | `^18.3.0` |
| antd | `4.10.3` | `^6.6.8` |
| echarts | 5.x era, **no `echarts/core` modular registration path** | `^6.1.0` |
| i18n (`t`, `tn`) | inside `@superset-ui/core` | moved out to `@apache-superset/core` |
| ECharts charts shipped | 17 | 23 — npm is **missing Bullet, Butterfly, Candlestick, Gantt, Rose, TimePivot** |
| schema validation | none | `zod ^4.6.7` + `eChartOptionsSchema` / `safeEChartOptionsParser` |

**Decision: do not install any `@superset-ui/*` package.** React 16 peers against this repo's React **19.0.0** (`os-ui/package.json`); `@emotion/*` + `antd 4` + `ace-builds`/`react-ace`/`brace` as new runtime surface; a 13.9 MB echarts plugin with no tree-shaken registration path when our whole chart layer is "register 7 ECharts modules" by design (`PanelChart.tsx:10-17`). **Read the monorepo and vendor files.** (Note that even master targets React **18**, so its *components* are not drop-in either — reinforcing "vendor pure functions, not components".)

### 2.3 What in the Superset frontend is backend-free vs Flask-coupled

Base: <https://github.com/apache/superset/tree/master/superset-frontend/>. All Apache-2.0.

**Reusable — pure React/TS, zero backend coupling:**

- **`src/dashboard/util/` — the layout algebra. The single highest-value, zero-coupling code in the repo.** Pure functions over the `position_json` tree: `dnd-reorder.ts`, `dropOverflowsParent.ts`, `getDropPosition.ts`, `getComponentWidthFromDrop.ts`, `getDetailedComponentWidth.ts`, `componentIsResizable.ts`, `findParentId.ts`, `findFirstParentContainer.ts`, `getEmptyLayout.ts`, `getChartIdsFromLayout.ts`, `findTabIndexByComponentId.ts`, `getDirectPathToTabIndex.ts`, `getDefaultActiveTabs.ts`, `embeddedLayout.ts`. **Copy these.** They encode years of "what happens when you drop a chart into a column that is already full" and they have no dependencies worth the name.
- `src/dashboard/util/componentTypes.ts` — the layout vocabulary.
- `src/dashboard/components/gridComponents/` — `Column/`, `Divider/`, `Header/`, `Markdown/`, `Row/`, `Tab/`, `Tabs/`, `TabsRenderer/`, `new/` (the add-panel palette cards). Only `Chart/` is backend-coupled.
- `src/dashboard/components/dnd/` — `DragDroppable.tsx`, `DragHandle.tsx`, `dragDroppableConfig.ts`, `handleDrop.ts`, `handleHover.ts`, `handleScroll/`, `AddSliceDragPreview.tsx`. The DnD engine — but built on **`react-dnd ^11.1.3`** (see below).
- `src/dashboard/reducers/` + `src/dashboard/actions/` layout slices — the layout state machine including undo/redo.
- `packages/superset-ui-core/src/query/` — `buildQueryContext.ts`, `buildQueryObject.ts`, `extractQueryFields.ts`, `processFilters.ts`, `convertFilter.ts`, `normalizeOrderBy.ts`, `normalizeTimeColumn.ts`, `getXAxis.ts`, `getMetricLabel.ts`, `getColumnLabel.ts`, `extractExtras.ts`, `extractTimegrain.ts`, `processExtraFormData.ts`, `types/`. Emits a JSON `query_context`; the *builders* are backend-agnostic — point them at our own executor.
- `packages/superset-ui-core/src/{number-format,time-format,currency-format,time-comparison,color,chart,validator,math-expression}` — the D3-based format catalogue and the time-comparison grammar. **Pure. Best copy candidate after the transformers.**
- `packages/superset-ui-chart-controls/src/` — `ControlPanelConfig`, `ControlPanelSectionConfig`, shared controls. Types + taxonomy portable; the rendering is antd+emotion.
- **`plugins/plugin-chart-*/src/**/transformProps.ts` + `src/utils/series.ts`** — pure `(chartProps) → EChartsOption`. **Entirely decoupled; the best reuse target of all.** Master's `plugin-chart-echarts` provides: BigNumber, BoxPlot, Bubble, Bullet, Butterfly, Candlestick, Funnel, Gantt, Gauge, Graph, Heatmap, Histogram, MixedTimeseries, Pie, Radar, Rose, Sankey, Sunburst, TimePivot, Timeseries (+ `Area`, `Regular/Bar`, `Regular/Line`, `Regular/Scatter`, `Regular/SmoothLine`, `Step`), Tree, Treemap, Waterfall. Its own deps are light: `d3-array ^3.2.4`, `lodash`, `acorn`, `zod`; peers `dayjs`, `echarts`, `memoize-one`, `react ^18.3.0`.
- `packages/superset-ui-switchboard` — 108 KB, no React peer. The one cheap installable piece; we don't need it (it exists for iframe RPC).

**Flask-coupled — reimplement, do not copy:**

- `packages/superset-ui-core/src/connection/` — `SupersetClient.ts`, `SupersetClientClass.ts`, `callApi/`, `normalizeBackendUrls.ts` (CSRF fetch, Flask-AppBuilder session semantics). Note this sits **inside** the package called "core".
- `src/components/Chart/chartAction.ts` — `POST /api/v1/chart/data`. **The single most important seam to replace** (ours is `/api/dashboards/panel-query` → `runPanelQuery`).
- `src/components/Chart/DrillDetail/DrillDetailPane.tsx`, `src/components/Chart/DrillBy/DrillByModal.tsx` — our `ui/DrillDrawer.tsx` already occupies this slot, governed.
- `src/explore/exploreUtils/`, `src/explore/components/ExploreViewContainer/` — the Explore page.
- 20 files under `src/dashboard` import `SupersetClient` (`actions/datasources.ts`, `actions/sliceEntities.ts`, `actions/dashboardState.ts`, `actions/dashboardInfo.ts`, `hooks/useDownloadScreenshot.ts`, `components/nativeFilters/FilterBar/keyValue.tsx`, `components/menu/DownloadMenuItems/`, `components/PropertiesModal/`, `components/nativeFilters/FiltersConfigModal/…`, …).
- `src/filters/components/`, `src/filters/utils.ts` — the native filter widgets, coupled to Superset's dataset/column metadata API.
- `src/embedded/utils.ts` — guest tokens (option C's machinery).
- `src/SqlLab/`, `src/views/`, `src/pages/`, `src/features/` — the FAB-coupled shell.

**`position_json` component types**, verbatim from `src/dashboard/util/componentTypes.ts`: `CHART`, `COLUMN`, `HEADER` (both `DASHBOARD_HEADER_TYPE` and `HEADER_TYPE` resolve to the string `'HEADER'`), `GRID`, `ROOT`, `DIVIDER`, `MARKDOWN`, `NEW_COMPONENT_SOURCE`, `ROW`, `TABS`, `TAB`, `DYNAMIC`. Shape: a **flat map** `{ [id]: { id, type, meta, children: [] } }` rooted at `ROOT_ID → GRID_ID`; `meta.width` on a 12-column grid, `meta.height` in grid units; chart nodes carry `meta.chartId` / `meta.uuid` / `meta.sliceName`.

**Grid substrate — Superset does NOT use `react-grid-layout`** (a code search over `apache/superset` returns zero hits). It uses **`react-dnd ^11.1.3` + `react-dnd-html5-backend ^11.1.3`** with a bespoke `DragDroppable.tsx` and a `ResizableContainer`. react-dnd 11 is five majors behind current (16.0.1) and upstream has been dormant since 2022-06. So: **copy Superset's layout *algebra*, but not its DnD substrate.** For ours, `react-grid-layout@2.3.0` is **MIT**, published 2026-10-05, peers `react: '>= 16.3.0'` — React-19-compatible and the standard substrate for exactly this job. (`@dnd-kit/*`, MIT, is the other modern option.)

### 2.4 Dependency licences for the plausible vendoring set

| Dependency | npm latest | SPDX | Allowlisted here? | Verdict |
|---|---|---|---|---|
| `echarts` | 6.1.0 | **Apache-2.0** | yes | **already a direct dependency** (`^5.6.0`) |
| `react-grid-layout` | 2.3.0 | MIT | yes | **recommended** for the layout grid (React ≥16.3 peer) |
| `react-dnd` / `react-dnd-html5-backend` | 16.0.1 | MIT | yes | only if a dnd substrate beyond react-grid-layout is wanted; upstream dormant since 2022-06 — prefer `@dnd-kit/*` (MIT). `@xyflow/react` is already in deps |
| `d3-array` / `d3-scale` / `d3-format` / `d3-time-format` | 3.2.5 / 4.0.3 / … | ISC | yes | acceptable, small, tree-shakeable — needed if the Superset formatters are vendored as-is |
| `@emotion/react` | 11.14.0 | MIT | yes | **avoid** — the OS uses plain CSS + custom properties |
| `antd` / `@ant-design/icons` | 6.7.0 / 6.3.4 | MIT | yes | **avoid** — a second design system inside the OS design system |
| `react-window` | 2.5.3 | MIT | yes | acceptable for a virtualized pivot/table grid |
| `immutable` | 5.2.1 | MIT | yes | **avoid** — Superset-era state plumbing we don't need |
| `recharts` | 3.10.1 | MIT | yes | second renderer — **no** |
| `@visx/visx` | 4.0.0 | MIT | yes | only for a bespoke viz ECharts cannot do |
| `jspdf` + `jspdf-autotable` | — | MIT | yes | **already direct dependencies** — use for PDF export |

No copyleft or source-available licence in this set; every id is already in `licenses/allowed-licenses.txt` and nothing trips `licenses/denied-licenses.txt` (SSPL, Elastic-2.0, ELv2, BUSL, BSL-1.1, Commons-Clause, **AGPL**). `os-ui`'s own `npm run check:licenses` allowlist matches, so **no new SPDX id enters the gate.**

**The one real licence trap in Superset's dependency graph: `mapbox-gl` went proprietary at v2.0** (Mapbox TOS, BSL-style). It is reachable through `legacy-plugin-chart-map-box` and the deck.gl presets. If the LATER map work ever happens, pin **`maplibre-gl` (BSD-3-Clause)** and never `mapbox-gl@>=2`. Also avoid `nvd3` (via `legacy-preset-chart-nvd3`): Apache-2.0 but abandoned and on d3 v3.

A side note that matters for planning: **all `legacy-plugin-chart-*` directories are gone from the monorepo** — the npm legacy packages are code the project itself deleted. heatmap, histogram, sankey, sunburst and treemap now exist **only** as ECharts charts. So the SHOULD/LATER chart list should be sourced from `plugin-chart-echarts` exclusively.

### 2.5 Superset's dashboard export format

`EXPORT_VERSION = "1.0.0"` (`superset/utils/dict_import_export.py:23`), `METADATA_FILE_NAME = "metadata.yaml"` (`superset/commands/export/models.py`). A **ZIP** from `GET /api/v1/dashboard/export/` (or `GET /api/v1/assets/export/` for everything):

```
metadata.yaml          # version: 1.0.0, type, timestamp
dashboards/*.yaml      # dashboard_title, description, css, uuid, version,
                       #   position:   <- position_json, inflated from JSON to YAML
                       #   metadata:   <- json_metadata, inflated (native_filter_configuration,
                       #                  chart_configuration/cross-filter scoping, color_scheme,
                       #                  expanded_slices, default_filters, refresh_frequency)
charts/*.yaml          # slice_name, viz_type, dataset_uuid, params, query_context,
                       #   cache_timeout, uuid, version
datasets/*.yaml        # table_name, schema, sql, columns[], metrics[], database_uuid, uuid, version
databases/*.yaml       # database_name, sqlalchemy_uri, extra, uuid, version
```

The inflation is explicit in `superset/commands/dashboard/export.py`: `JSON_KEYS = {"position_json": "position", "json_metadata": "metadata"}`, with `DEFAULT_CHART_HEIGHT = 50` and `DEFAULT_CHART_WIDTH = 4`. Cross-references are by **uuid** (not integer id), which is what makes the bundle portable. Minimum valid import = `metadata.yaml` with `version: 1.0.0` plus the four asset directories.
Docs: <https://superset.apache.org/developer-docs/api/export-all-assets/>, <https://superset.apache.org/developer-docs/api/dashboards/>; origin PR <https://github.com/apache/superset/pull/11351>.

**Strategic note:** because the bundle is uuid-keyed and version-stamped, *reading and writing this format is a cheap interoperability win that needs no vendored UI at all.* Worth a LATER item: "import a Superset dashboard export" as a migration path for customers leaving Superset.

### 2.6 Alternatives — exact licences

| Project | SPDX | LICENSE URL | Usable for us? |
|---|---|---|---|
| **Apache Superset** | Apache-2.0 | <https://github.com/apache/superset/blob/master/LICENSE.txt> | **yes — the primary copy source** |
| **Apache ECharts** | Apache-2.0 | <https://github.com/apache/echarts/blob/master/LICENSE> | **yes — already in** |
| **Perses** (CNCF Sandbox) | Apache-2.0 | <https://github.com/perses/perses/blob/main/LICENSE> | **format yes, packages no** — see below |
| **Rill** | Apache-2.0 | <https://github.com/rilldata/rill/blob/main/LICENSE.md> (note `.md`) | permitted; Go + Svelte + DuckDB — wrong stack to copy from. (`@rilldata/rill` on npm is a stale 2024 package with no licence field — use the repo) |
| **Evidence** | MIT | <https://github.com/evidence-dev/evidence/blob/main/LICENSE> | permitted; Svelte. Its *authoring* model ("a dashboard is a markdown+SQL file") is a reference for §4.4 |
| **Grafana** | **AGPL-3.0-only** since v8.0.0 (relicensed 2021-04-20, "Re-license Grafana to AGPLv3 (#33184)"; `LICENSE` at v7.5.0 = Apache-2.0) | <https://github.com/grafana/grafana/blob/main/LICENSE>, <https://github.com/grafana/grafana/blob/main/LICENSING.md> | **app: hard NO** — `AGPL` is on `licenses/denied-licenses.txt`. **But `LICENSING.md` carves out `packages/grafana-data`, `grafana-ui`, `grafana-runtime` as Apache-2.0**, and `@grafana/scenes` **9.2.2 is Apache-2.0** with peers `react ^18 \|\| ^19` — React-19-ready. It also needs `@grafana/runtime`/`data`/`i18n`/`schema`/`e2e-selectors` ≥12.4 + `rxjs` + `react-router-dom`: a Grafana plugin runtime in all but name. **Licence-clean, architecturally wrong — note as fallback, do not adopt** |
| **Metabase** | **AGPL-3.0 + Metabase Commercial + a third, proprietary embedding EULA** | <https://github.com/metabase/metabase/blob/master/LICENSE.txt> (+ `LICENSE-AGPL.txt`, `LICENSE-MCL.txt`, `LICENSE-EMBEDDING.txt`, `enterprise/LICENSE.txt`) | **NO.** Verbatim: "Outside of the top-level 'enterprise' directory, source code … is licensed under the AGPL. Within … 'enterprise' …, the Metabase Commercial License." `app-embed.js` carries its own click-through EULA |
| **Lightdash** | **MIT core + "Lightdash Source Available License" for `packages/backend/src/ee/`** | <https://github.com/lightdash/lightdash/blob/main/LICENSE>, <https://github.com/lightdash/lightdash/blob/main/packages/backend/src/ee/LICENSE> | **do not copy.** The carve-out was added **2025-01-27 in PR #13402** (v0.1465.0): production use needs an Enterprise Subscription, copying/distributing/selling is forbidden, **IP in your modifications assigns to Telescope Technology Limited**, and it auto-terminates on breach. `@lightdash/cli` on npm still declares plain `MIT` — **npm metadata understates the restriction; verify against the repo** |
| **Redash** | BSD-2-Clause | <https://github.com/getredash/redash/blob/master/LICENSE> | permitted; Python/Flask + Angular-era frontend — nothing worth lifting |
| **Streamlit** | Apache-2.0 | <https://github.com/streamlit/streamlit/blob/develop/LICENSE> | permitted; Python — wrong stack. (npm `streamlit` is an unrelated ISC package — do not use it to attest the licence) |
| **Plotly Dash** | MIT | <https://github.com/plotly/dash/blob/dev/LICENSE> | permitted; Python — wrong stack. (npm `dash` points at dashevo/DashJS — unrelated) |
| **Observable Framework** | ISC | <https://github.com/observablehq/framework/blob/main/LICENSE> | permitted; static-site build model, not a component source. Publish cadence has slowed (last publish 2026-04-06) |
| **Vega-Lite** | BSD-3-Clause | <https://github.com/vega/vega-lite/blob/main/LICENSE> | permitted — but a second chart renderer; the OS standardised on ECharts in three places. **No** |
| **Cube** | Apache-2.0 default, some MIT; **no BSL anywhere** | <https://github.com/cube-js/cube/blob/master/LICENSE>, <https://github.com/cube-js/cube/blob/master/packages/cubejs-client-core/LICENSE> (MIT) | permitted. Root LICENSE: "The default license throughout the repository is Apache License 2.0 unless the header or package LICENSE file specifies another license." `cubejs-client-core` MIT; `cubejs-api-gateway`, `cubejs-backend-native`, `cubejs-cubestore-driver`, `rust/cubestore`, `rust/cubesql` Apache-2.0. The OS's `View.measure` member vocabulary is a Cube naming legacy (`tabs/dashboards/guide.md`, `context.md`), not a dependency |
| **Metriql** | Apache-2.0, **dormant** (last commit 2023-03-08, v0.15) | <https://github.com/metriql/metriql/blob/master/LICENSE> | not worth it |
| **Tremor** | Apache-2.0; `tremor-blocks` MIT | <https://github.com/tremorlabs/tremor/blob/main/LICENSE>, <https://github.com/tremorlabs/tremor-npm/blob/main/LICENSE> | **no** — team joined Vercel Jan 2025; no stable release since 3.18.7 (2025-01-13), only `4.0.0-beta-*`, with open React-19 issues |
| **recharts** / **visx** | MIT / MIT | npm | permitted; second renderers (see Vega-Lite) |
| `@superset-ui/embedded-sdk` 0.4.0 | Apache-2.0 (ASF-governed, source in `superset-embedded-sdk/`) | covered by Superset's `LICENSE.txt` | licence-fine, **architecturally rejected** — it exists to iframe a Superset server, i.e. option (C) |

**`@perses-dev/*` — maintained, Apache-2.0, React 18:** `@perses-dev/dashboards`, `components`, `plugin-system`, `explore` all **0.55.1, published 2026-11-04**; `@perses-dev/core` 0.54.0 (2026-08-24). Peers of `dashboards`: `react ^18.3.0`, `react-dom ^18.3.0`, `@mui/material ^6.1.10` (MIT), `@tanstack/react-query ^4.39.1` (MIT). Newer builds come from `github.com/perses/shared`, also Apache-2.0. CNCF Sandbox, no enterprise edition. **Verdict: copy the dashboard-as-code *format* ideas (§4.4), not the packages** — React 18 + a MUI design-system commitment inside a React-19 OS, and the panel model is observability/Prometheus-shaped rather than SQL-BI-shaped.

### 2.7 "Superset-lite" permissive React dashboard builders worth reading

1. **NeoDash** — <https://github.com/neo4j-contrib/neodash> — **Apache-2.0**, ★517, last push 2026-10-22. The closest structural analogue to what we are building: a React dashboard *builder* on `react-grid-layout`, with a card/report model, a per-card query editor and JSON dashboard save/load. **Its card ↔ grid-layout ↔ saved-JSON loop is the pattern to lift**, and Apache-2.0 → Apache-2.0 is a clean vendor. (React 17, so read rather than install.)
2. **Grafana Scenes** — <https://github.com/grafana/scenes>, npm `@grafana/scenes@9.2.2` — **Apache-2.0** (not AGPL like Grafana core). A composable React scene graph: layout nodes, variables, time-range sync, data providers. The most mature answer to what Superset solves with `getFormDataWithExtraFilters.ts` + its native-filter machinery, at a fraction of the size. **Licence-clean to copy from**; too much runtime to adopt whole.
3. **Appsmith** — <https://github.com/appsmithorg/appsmith> — **Apache-2.0**, ★41.2k. A production-grade drag-drop canvas + widget registry + property-pane system in React. Far larger than needed, but the **widget-config / property-pane abstraction is a good reference for replacing `ControlPanelConfig`**. Vendor selectively.

**Avoid (copyleft, verified):** ToolJet **AGPL-3.0**, Lowcoder **AGPL-3.0**, Budibase **GPL-3.0/NOASSERTION**. All three otherwise tempting; all incompatible with an Apache-2.0 distribution and all caught by `licenses/denied-licenses.txt`.

### 2.8 Licence conclusion and how we credit it

**We may vendor Apache Superset source into this Apache-2.0 repo freely.** Three chores: keep each copied file's ASF header intact (§4(a)/(c)); add a prominent per-file "Modified from apache/superset `<path>` @ `<sha>`" notice to everything we change (§4(b)); and keep Superset's NOTICE reproduced (§4(d)) — which `NOTICE` lines 19-27 and `licenses/notices/Apache-Superset-NOTICE.txt` **already do**. Nothing in the dependency set or the alternatives set adds a new SPDX id to `licenses/allowed-licenses.txt`; the only attractive-but-forbidden sources are Grafana's app, Metabase and ToolJet/Lowcoder/Budibase (AGPL/GPL, hard-denied) and Lightdash's `ee/` (source-available, IP-assigning).

**How to record it in this repo's existing machinery:**

1. **`licenses/components.tsv:33`** — replace the bundled-app row (`Superset  chart 0.17.2 / app 6.1.0  Apache-2.0  yes  …  Dashboards/BI; NOTICE bundled`) with a vendored-source row: `Apache Superset (vendored source)  <monorepo commit sha>  Apache-2.0  yes  licenses/Apache-2.0.txt  Vendored chart transformers, formatters + layout algebra under os-ui/vendor/superset/; NOTICE bundled`. Do it in the **same change** that drops the Superset Helm chart (checklist item **D21**), so the manifest never claims an app we deleted. Pin the **sha**, not a version — vendored source has no release.
2. **`licenses/notices/Apache-Superset-NOTICE.txt`** — **keep unchanged.** §4(d) applies to derivative works as much as to redistributed binaries.
3. **`NOTICE`** — keep lines 19-27; optionally extend the Superset paragraph with "Portions of this product are derived from Apache Superset source; see `os-ui/vendor/superset/`."
4. **`THIRD-PARTY-LICENSES.md:104`** — update the Superset row to mirror the new TSV row (the file mirrors the TSV by design). Also check the image list at `:157`, which still names a `superset` image we build.
5. **`sbom.cdx.json`** — regenerate via `scripts/license-check.sh --update-sbom`; both passes (syft deny-scan + the `components.tsv` allowlist gate) must stay green.
6. **`os-ui/core/kernel/licenses.ts:22`** — the in-product About/Licenses list names **neither ECharts nor Superset**, which is a real gap today (ECharts has shipped in the UI since the native dashboards landed). Add `Apache ECharts` (Apache-2.0, OS UI), `Apache Superset (vendored chart transformers)` (Apache-2.0, OS UI), and `react-grid-layout` (MIT) if adopted.
7. **Per-file convention** for `os-ui/vendor/superset/` — ASF header retained verbatim, then our modification notice:

```ts
/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * ...  (ASF header retained VERBATIM — never replaced)
 *
 * Modified from apache/superset superset-frontend/plugins/plugin-chart-echarts/
 *   src/Timeseries/transformProps.ts @ <sha>, by Borek Data Ventures UG
 *   (haftungsbeschränkt), 2026. Changes: ported to the OS ExploreSpec result
 *   shape; antd/emotion imports removed; types narrowed to the OS VizType union.
 * SPDX-License-Identifier: Apache-2.0
 */
```

Note that `scripts/check-structure.mjs` enforces a `FEATURE:` / `USER STORY:` / `ARCHITECTURE:` header on OS source files — **`os-ui/vendor/` must be excluded from that ratchet**, because ASF policy forbids us from rewriting third-party headers. Add the exclusion in the same change as the first vendored file.

8. **Trademarks** — product copy says "dashboards include code derived from Apache Superset"; never "Superset inside", never a Superset or feather logo, never "superset" in a route or a package name.

---

## 3. Audit of the OS today

### 3.1 Where the code is

`os-ui/tabs/dashboards/` — 5 049 lines across 35 files. Contract: `tabs/dashboards/manifest.ts:14-22` (route `/dashboards`, API `/api/dashboards`, MCP tool group `dashboard-write`, services `trino` + `opensearch`).

```
lib/model.ts            188  the spec (pure, tested)            tabs/dashboards/lib/model.ts
lib/build/panel-query.ts 212  the governed server boundary
lib/panel-views.ts       55  the palette (entitled views/members)
lib/store.ts            349  registry: list/get/save/promote/folder/version/archive/delete
lib/governance.ts        51  tiers + role gates
lib/reports.ts           58  scheduled-report due/send decision (pure)
lib/delivery.ts          86  in-app delivery of reports + alerts
lib/folder-adapter.ts    52
ui/DashboardBuilder.tsx 605  View/Edit shell + lifecycle header
ui/DashboardGrid.tsx    440  the viewer: flow layout, chips, grain switcher
ui/PanelChart.tsx       334  ECharts option builder + KPI + table + CSV
ui/PanelBuilder.tsx     328  the "explore" form
ui/DrillDrawer.tsx      160  drill-down (re-queries governed SQL)
ui/PanelExpand.tsx       88  full-screen panel
ui/Tiles.tsx            340  the list surface
ui/Reports.tsx           76
mcp/dashboard-write-tools.ts 196  create_dashboard (the ONLY write tool)
```

API routes (`app/api/dashboards/`): `route.ts`, `build/`, `panel-query/`, `views/`, `reports/`, `connect-info/`, `assistant/`, `[id]/{route,promote,demote,folder,versions}`. Plus `app/api/data/datasets/[id]/dashboards/route.ts` (dashboards for a dataset).

### 3.2 The data model

`DashboardSpec` (`tabs/dashboards/lib/model.ts:82-95`):

```ts
type DashboardSpec = {
  name: string;
  view: string;              // ONE governed view — the hard architectural limit
  charts: ChartSpec[];       // ChartSpec === Panel
  domain?: string;
  filters?: PanelFilter[];   // default cross-filter chips
};
type Panel = { name; vizType; metrics: string[]; metric?; dimensions?; timeDimension?;
               timeGrain?; filters?: PanelFilter[]; gridPos?: GridPos };
type VizType = 'big_number_total'|'big_number'|'line'|'area'|'bar'|'pie'|'table';  // model.ts:29
type PanelFilter = { member: string; operator: string; values: string[] };          // model.ts:32
type GridPos = { x; y; w; h };                                                      // model.ts:36
```

Findings:

1. **One view per dashboard.** `spec.view` is a single string (`model.ts:84`). A dashboard cannot mix two data products. `PanelBuilder` enforces it (`ui/PanelBuilder.tsx:156` — `inView` filters the palette to `effectiveView`). This is the biggest modelling gap vs Superset, where each chart carries its own dataset. *In practice panels already carry their view in the member prefix* (`panel-query.ts:119` literally does `void view;` with the comment "the panel's members already encode the view"), so **removing the single-view restriction is mostly a UI + validation change, not a query change.**
2. **No layout.** `gridPos.x/y/h` are dead: `spanOf()` reads only `w` (`ui/DashboardGrid.tsx:30`) and `PanelBuilder` writes `{x:0,y:0,w:width,h:1}` (`ui/PanelBuilder.tsx:175`). Order is array order. No tabs, no rows, no markdown tile, no drag-to-position, no resize handles.
3. **Dedupe key is good.** `panelKey` includes vizType + members + dimensions + time + filters (`model.ts:106-119`) so the two build modes (drag-drop `fromTiles`, agent `fromAgent`) converge on one artifact and `sameDashboard` is a real equality (`model.ts:156`).
4. **Filters are equality-only and silently narrowed.** `panel-query.ts:134-137` keeps only `operator === 'equals'`; everything else is dropped. `PanelFilter.operator` is typed `string`, so an agent can write `>=` and get silently under-filtered — the one place the module's otherwise-excellent honesty discipline has a hole (the drop is not reported in `warning`).

### 3.3 How data is fetched — metrics, not datasets, not SQL

`runPanelQuery` (`tabs/dashboards/lib/build/panel-query.ts:107`):

- a panel's `metrics` are **governed metric members** (`View.measure`); resolved through the RLS-scoped metrics registry (`registryResolver`, `panel-query.ts:54-67` → `listMetrics` + `getMetric`). A member outside the viewer's entitlement cannot resolve.
- each member is then executed by `exploreMetric` (`tabs/metrics/lib/build/explore-server.ts`) — the **same compiled-SQL path the Metrics explorer and the `query_metric` MCP tool use**. So a panel number is by construction the number the explorer shows (`panel-query.ts:13-23`).
- identity: `propagate(token)` at `panel-query.ts:114` throws unless the token is user-delegated, and threads the viewer principal + groups to Trino (`tabs/data/lib/identity.ts:109-132`). OPA authorizes the tool (`core/infra/governed.ts:47`), Trino applies row/column security.
- multi-measure panels run their explores **concurrently** then merge on a `sliceKey` (`panel-query.ts:78-85`, `:164-179`).
- **honesty machinery to preserve verbatim in any rewrite:** `missingPanelMembers` (`model.ts:185`) + `missingMembersWarning` (`panel-query.ts:203`) + the warning precedence at `panel-query.ts:184-187` (outage > unresolved member > dropped slice dimension). A real Trino outage yields **no rows and a warning**, never a fabricated number. This is a differentiator over Superset, which happily renders an un-grouped bar when a column disappears.
- **datasets and raw SQL are not reachable from a panel at all.** There is no `query_data`-backed tile. The Data tab's `ExplorePanel`/`queryRun` (`core/infra/governed.ts:117`) is a separate surface.

### 3.4 Governance, sharing, promotion

- Tiers `personal → domain → marketplace` reusing the *data* lifecycle gate so dashboards can't drift from datasets/metrics on who-may-do-what (`tabs/dashboards/lib/governance.ts:9-15,38-51`).
- Store: principal-scoped `listDashboards` → `{mine, domain, marketplace}` (`lib/store.ts:137-149`); `getDashboard` is a visibility guard (`:175`); `saveDashboard` upserts under the caller's id (`:184`); `transitionDashboard` promote/certify (`:226`); `demoteDashboard` (`:243`); folders (`:283`), archive (`:269`), delete (`:316`), **version log + restore** (`:325`, `:335`).
- Edit scope: a `personal`-tier dashboard is owner-only — not even an admin reads another user's private dashboard (`lib/store.ts:29-32`).
- Persistence is **in-memory + an OpenSearch write-through mirror** (`lib/store.ts:38-63`, `osMirror({index:'os-dashboards'})`), with `spec` stored as `{type:'object', enabled:false}`. A fresh tenant starts empty (`lib/store.ts:36`).
- **Dashboards are NOT in git.** Agent systems are (`tabs/agents/lib/git/commit.ts`), the dbt project is (`tabs/data/lib/dbt/commit.ts`), dashboards are not. The reusable machinery is already there: `reserveSubtree` (`core/infra/git-store.ts:289`) and `commitSubtree` (`:499`) exist precisely so a second generator can own a path prefix in the domain repo — `agents/` is already reserved (`tabs/agents/lib/git/commit.ts:186`). **`dashboards/` is free.**

### 3.5 MCP surface vs the ask

| Tool | Status |
|---|---|
| `create_dashboard` | exists — `tabs/dashboards/mcp/dashboard-write-tools.ts:30-105`. Persist-only; flags missing members at create (`:75-102`). Its `vizType` enum is **`['big_number_total','line','bar','table']`** (`:48`) — i.e. the schema advertises **fewer** types than the model supports (`pie`/`area`/`big_number` missing) |
| `get_dashboard` | exists — `tabs/admin/mcp/discovery-waveb-tools.ts:110-142` |
| `list_dashboards` | exists — `tabs/admin/mcp/discovery-read-tools.ts:350-357` |
| `update_dashboard` | **absent** — the documented idiom is "call `create_dashboard` again with the same `id`" (`tabs/dashboards/guide.md`, step 4). Whole-spec replace only; no patch |
| `add_chart` | **absent** |
| `render_dashboard_data` | **absent** — an agent cannot read a dashboard's *numbers*; it must call `query_metric` per member. `/api/dashboards/panel-query` is UI-only |
| Registration | `core/mcp/register-experimental.ts:110-118` — the dashboards tools are behind the `dashboards` experimental feature flag |

### 3.6 Metrics-tab consumption (the R1 interface)

- `ExploreSpec` (`tabs/metrics/lib/explorer.ts:13-28`) is the OS's query DSL: `member`, `dimensions[]`, `timeDimension` + `granularity`, `limit`, equality `filters[]`, and `dropped[]` (the loud-degradation record). `Granularity = day|week|month|quarter|year` (`:21`).
- `exploreSpec()` (`:31`) reconciles every requested member against the view's member set and records drops instead of silently de-dimensioning (`:43-58`).
- `previewTrinoSql` (`:249`) and `dropToSql` (`:77`) are the SQL surfaces; `sqlRowsToExploreRows` (`:273`) is the row shaper.
- **Conclusion for R1/R2 interface:** `ExploreSpec` is *already* a usable analogue of Superset's `QueryObject`. The dashboard panel should compile to it (one `ExploreSpec` per measure, as today) rather than to a new DSL. What it lacks vs Superset's `QueryObject`: non-equality filter operators, `orderby`, `series_limit`, `row_offset`, time *range* (since/until), and post-processing (pivot, rolling, compare, cum).

### 3.7 Design system / chart components

- **Only three ECharts call-sites in the whole repo**: `tabs/dashboards/ui/PanelChart.tsx`, `tabs/software/ui/appspec/ChartExplorerRenderer.tsx`, `tabs/data/ui/ResultChart.tsx`. Each registers its own tree-shaken ECharts bundle independently (`PanelChart.tsx:10-17` registers Line/Bar/Pie + Grid/Tooltip/Legend + Canvas; `ChartExplorerRenderer.tsx:8-17` registers Line/Bar only). **There is no shared chart component in `core/ui/`** — `core/ui/` has `Markdown.tsx`, `PageHeader.tsx`, `Sidebar.tsx`, `core/*` shells, `lifecycle/*`, but no `charts/`.
- `echarts: ^5.6.0` is a direct dependency (`os-ui/package.json`). React **19.0.0**, Next **15.5.19**. There is **no** `echarts-for-react` — a deliberate choice: "a thin custom wrapper avoids echarts-for-react peer-dep friction with React 19" (`PanelChart.tsx:8-9`). **This decision is the crux of §2/§4: React-19-era code cannot take @superset-ui's React-16/17 peer graph.**
- Theming: ECharts colours are read from CSS custom properties at render time (`PanelChart.tsx:35-40`), so charts follow the OS light/dark theme natively.
- **Recommendation:** the first deliverable of this workstream is `core/ui/charts/` — one registration surface, one `<Chart option>` wrapper, one theme resolver, one formatter module — consolidating the three forks. Everything else builds on it.

### 3.8 Could dashboards be Software-tab apps?

`tabs/software/ui/appspec/` holds 21 renderers (`AppSpecRenderer`, `ChartExplorerRenderer`, `KpiCards`, `TableViewRenderer`, `StatusBoardRenderer`, …) driven by an app **spec** and an `OsClient`/`QueryResult` SDK (`@core/app-sdk/index`), with `ChartExplorerConfig` from `tabs/software/lib/appspec/patterns`. So the OS **already has a second, spec-driven, chart-rendering runtime**.

Conclusion: dashboards should **not** become apps (a dashboard is a governed artifact with its own ladder, versioning, folders and promotion). But the renderer must be shared: `core/ui/charts/` + a `renderDashboard(spec, rows)` component consumed by *both* `tabs/dashboards` and an `appspec` `DashboardEmbedRenderer`. That is how "embedding in Software apps" (requirement U11) gets delivered for near-zero cost — and it is strictly better than Superset's iframe+guest-token embedding because it stays in-process under the viewer's identity.

### 3.9 Against the MUST list

| MUST | Today |
|---|---|
| Table | partial (no sort/paging/totals) |
| Big Number (+trendline) | partial (no trendline/compare) |
| Time-series line/area/bar | yes |
| Bar categorical | yes |
| Pie | yes |
| **Pivot table** | **no** |
| **Markdown/header tile** | **no** |
| **Native filter bar** | no (chips only, equality only) |
| Cross-filter | yes (equality) |
| Drill-down / drill-by | yes |
| Dashboard time grain | partial (viewer switcher) |
| **Dashboard time range** | **no** |
| **Layout grid + resize + tabs** | **no** |
| Chart explore (metric×dim×grain×filter) | partial (1 dimension, equality only, no limit/sort, SQL not surfaced) |
| RLS from identity | **yes — stronger than Superset** |
| Owners/certification/versioning | yes |
| CSV export | partial (per-panel table) |
| **Export/import as code** | **no** |
| Row limit / cost guard | partial |
| **`update_dashboard` / `add_chart` / `render_dashboard_data`** | **no** |

---

## 4. Architecture options and recommendation

### 4.1 The three options

**(A) Vendor `@superset-ui/core` + `plugin-chart-echarts` control-panel semantics into `tabs/dashboards`, with an OS query layer.**
Install/vendor the Superset packages; keep their `QueryFormData` + `ControlPanelConfig` shapes; adapt their chart plugins to an OS query layer that compiles form-data → `ExploreSpec` → governed Trino SQL (metrics via the R1 compiler, datasets via `query_data`); write (or adapt) OS-native grid + filter bar; execute server-side as the signed-in user.

*Pro:* the control-panel taxonomy and the ECharts option transformers are the genuinely expensive, genuinely good parts of Superset, and they come with ~15 chart types' worth of design decisions already made.
*Con:* the packages carry a React 16/17-era peer graph with `antd`, `@emotion`, `d3-*`, `lodash` and a `moment`/`dayjs` mix — against this repo's React **19.0.0** (`os-ui/package.json`), which has already had to hand-roll an ECharts wrapper to avoid exactly this class of friction (`PanelChart.tsx:8-9`). Their React *components* are also Redux- and `SupersetClient`-coupled; only the transformers are portable. And they add new SPDX surface to `npm run check:licenses` and the SBOM.

**(B) Build fresh on ECharts with a Superset-inspired "form data" model.**
Keep `Panel` as the form-data analogue, extend it toward Superset's `QueryFormData`, write our own option builders, our own grid, our own filter bar — zero new dependencies beyond what's installed.

*Pro:* fits the repo's actual constraints (React 19, Next 15 app router, server components, `'use client'` leaves, one tree-shaken ECharts registration, CSS-custom-property theming). No licence surface, no bundle risk, nothing to upgrade.
*Con:* reinvents the ECharts option-building and the control taxonomy, which is weeks of fiddly work and the place where a home-grown dashboard looks home-grown.

**(C) Embed/bundle Superset as a component.**
*Rejected, and already rejected by the programme.* This is the status quo being removed: `licenses/components.tsv:33` lists `Superset chart 0.17.2 / app 6.1.0` as a bundled component, and the v2-lean direction removes it. The reasons it must not come back: (i) **identity** — a bundled Superset needs its own auth, its own RLS rules and a guest-token round-trip, so "two viewers of one dashboard see different rows" becomes Superset's promise rather than Trino's, and the OS's `propagate(token)` guarantee (`panel-query.ts:114`) is bypassed; (ii) the OS has already deleted the import step by design and says so in code (`app/api/dashboards/connect-info/route.ts:11-16`, `tabs/dashboards/guide.md`); (iii) a Flask+Celery+Redis+metadata-DB app is the single heaviest thing in the bundle for one tab's worth of value; (iv) a dashboard would stop being an OS artifact — no ladder, no folders, no version log, no git, no MCP.

### 4.2 Recommendation — **(B+)**: build fresh, vendor four surgical slices of Superset source

Take option **B** as the architecture, and *inside* it vendor a small, strictly-source, strictly-pure set of Superset files under `os-ui/vendor/superset/` with their headers intact:

1. **ECharts option transformers** — from `superset-frontend/plugins/plugin-chart-echarts/src/**/transformProps.ts` and `src/utils/series.ts`. These are the functions turning "rows + form data" into an ECharts `option`: series building, stacking, `sortAndFilterSeries`, axis/label formatting, legend layout, `extractTimeseriesSeries`, the tooltip formatters. **Copy verbatim** where they are pure over `(data, formData)`; they are the single highest-value, lowest-coupling thing in the whole Superset frontend. Take: `Timeseries` (line/area/bar/scatter), `Pie`, `Funnel`, `Gauge`, `Heatmap`, `Waterfall`, `BoxPlot`, `Radar`, `Treemap`. Skip `Graph`/`Sankey`/`MixedTimeseries` for now.
2. **Time-range grammar + formatters** — from `superset-frontend/packages/superset-ui-core/src/time-format/**`, `number-format/**` and the time-range/`fetchTimeRange` grammar in `src/query/`. The human time-range vocabulary ("Last week", "Last 28 days", "previous calendar month", "DATEADD(DATETIME('today'), -7, day)") plus the D3-based number/date format catalogue. **Copy the grammar and the format catalogue; re-implement the evaluation** against the OS's `Granularity` and Trino's date functions.
3. **Control-panel taxonomy** — from `superset-frontend/packages/superset-ui-chart-controls/src/**` (`ControlPanelConfig`, `ControlPanelSectionConfig`, `sharedControls`) and each plugin's `controlPanel.tsx`. **Do not copy the components** (antd 6 + emotion). **Copy the taxonomy as data:** per viz type, which controls exist, which are required, which are mutually exclusive, the defaults and the validators. That table is what makes Superset's Explore feel complete, and it is exactly what `ui/PanelBuilder.tsx` is missing (today: one dimension, no limit, no sort — `PanelBuilder.tsx:113-177`).
4. **The `position_json` layout algebra** — from `superset-frontend/src/dashboard/util/`: `dnd-reorder.ts`, `dropOverflowsParent.ts`, `getDropPosition.ts`, `getComponentWidthFromDrop.ts`, `getDetailedComponentWidth.ts`, `componentIsResizable.ts`, `findParentId.ts`, `findFirstParentContainer.ts`, `getEmptyLayout.ts`, `getChartIdsFromLayout.ts`, `findTabIndexByComponentId.ts`, `getDirectPathToTabIndex.ts`, `getDefaultActiveTabs.ts`, plus `componentTypes.ts`. These are **pure functions with essentially no dependencies** and they encode years of answers to "what happens when you drop a chart into a column that is already full". Copying them turns the layout work (the single biggest MUST item) from design into porting. Take the `ROOT/GRID/TABS/TAB/ROW/COLUMN/CHART/MARKDOWN/HEADER/DIVIDER` vocabulary with them.

Explicitly **reimplement, do not copy**: the DnD *substrate* (Superset's is `react-dnd ^11.1.3` — five majors stale, upstream dormant since 2022-06 — plus a bespoke `DragDroppable` and Redux reducers; use **`react-grid-layout@2.3.0`**, MIT, peer `react >= 16.3.0`, or `@dnd-kit/*`), the native filter bar containers (`src/filters/components/`, coupled to Superset's dataset-metadata API), `SupersetClient` / `POST /api/v1/chart/data` (our seam is `/api/dashboards/panel-query` → `runPanelQuery`), SQL Lab, the Redux stores, theming (the OS's CSS-custom-property bridge at `PanelChart.tsx:35-40` is better integrated), and anything touching Superset's permission model.

**Prerequisite, do first:** `core/ui/charts/` — one ECharts registration surface, one `<Chart>` wrapper, one theme resolver, one formatter module — consolidating the three independent registrations at `tabs/dashboards/ui/PanelChart.tsx:10-17`, `tabs/software/ui/appspec/ChartExplorerRenderer.tsx:8-17` and `tabs/data/ui/ResultChart.tsx`. Every vendored transformer lands behind it.

### 4.3 Effort per MUST capability

Engineer-days for one focused engineer (or one autonomous session each, roughly). "Vendor" marks work that is mostly porting Superset source rather than designing.

| MUST capability | Effort | Notes |
|---|---|---|
| `core/ui/charts/` consolidation (prerequisite) | **1.5 d** | 3 call-sites, 1 wrapper, theme + formatters |
| Table panel: sort, paging, totals, number formats | **2 d** | formats = vendored |
| Big Number + trendline + period comparison | **1.5 d** | needs time-range first |
| Time-series line/area/bar: stacking, dual axis, series limit, sort | **2 d** | vendor `Timeseries/transformProps` |
| Bar categorical: grouped/stacked/horizontal | **1 d** | same transformer |
| Pie/donut polish (labels, roseType, limit+other) | **0.5 d** | vendor `Pie/transformProps` |
| **Pivot table** (2-dim, subtotals, %-of-total) | **4 d** | SQL-side pivot + a grid; the single biggest chart item (R6) |
| Markdown / header / divider tiles | **1 d** | `core/ui/Markdown.tsx` exists |
| **Layout**: tree model + drag + resize + rows + tabs | **3.5 d** (was 5 d) | biggest item; **vendor `src/dashboard/util/` layout algebra** + `react-grid-layout` (MIT) rather than designing it (§4.2 item 4) |
| **Native filter bar**: value, date-range, numeric-range, grain; defaults; "all panels" scope | **4 d** | + 3 d for per-panel scoping and dependencies (SHOULD) |
| Cross-filter upgrade (multi-value, non-equality, clear-all, emit/consume per panel) | **2 d** | builds on the chips that exist |
| Dashboard **time range** (human grammar → Trino predicates) | **2.5 d** | vendor the grammar; implement against Trino |
| Explore upgrade: n dimensions, row limit, sort, "View query", viz-switch preservation | **3 d** | `PanelQueryResult.sql` already on the wire |
| Multi-view dashboards (U1/D2) | **1.5 d** | mostly UI + validation; the executor already ignores `spec.view` |
| Filter-operator hardening (D10) | **0.5 d** | typed rejection instead of a silent drop |
| CSV (dashboard-wide) + PNG + PDF | **2 d** | `jspdf` already a dependency |
| MCP parity: `update_dashboard`, `add_chart`, `remove_chart`, `render_dashboard_data`, enum fix | **2.5 d** | |
| **Dashboard-as-code in git** (generator + reader + commit hook + goldens) | **3 d** | `commitSubtree`/`reserveSubtree` exist |
| Principal-keyed cache + row limits + query budget | **2 d** | security-critical (R7) |
| Promotion tier-consistency gate (D19) | **0.5 d** | |
| Embed in Software apps (`DashboardEmbedRenderer`) | **1 d** | free once `core/ui/charts/` lands |
| Licence/NOTICE/SBOM hygiene for the vendored set (D21/D22) | **1 d** | |
| **MUST total** | **≈ 41.5 engineer-days** | ~8 weeks for one engineer; ~4 with two working the chart tier and the layout/filter tier in parallel |

SHOULD tier (heatmap, funnel, gauge, scatter, per-panel filter scoping, time comparison, saved queries, per-recipient snapshot rendering, PNG/PDF scheduling) adds roughly **15-18 d**. LATER tier (maps, deck.gl, annotations, Sankey/treemap/sunburst/radar/box-plot, handlebars) is deliberately out.

### 4.4 Dashboard-as-code — the file format

Stored in the **owning domain's git repository**, under a reserved subtree `dashboards/`, written with `commitSubtree` (`core/infra/git-store.ts:499`) after `reserveSubtree('dashboards/')` (`:289`) — exactly the pattern `agents/` already uses (`tabs/agents/lib/git/commit.ts:186`). One directory per dashboard; one YAML plus a README, so a checkout is readable by a human and by dbt-literate engineers.

```
dashboards/
  index.yml                       # slug → {name, owner, tier, updatedAt} (the repo's own index)
  sales-overview/
    dashboard.yaml                # THE artifact
    README.md                     # generated: what it charts, who owns it, how to open it
```

```yaml
# dashboards/sales-overview/dashboard.yaml
apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: dash_sales_overview_ab12cd      # stable OS id (also the git path slug source)
  name: Sales Overview
  domain: analytics
  owner: alex@datamasterclass.com
  tier: domain                        # personal | domain | marketplace
  description: Revenue and orders for the EU region.
  tags: [revenue, weekly-review]
spec:
  # ---- data sources, by STABLE OS ID (never a UUID blob, never an inline SQL string)
  sources:
    - ref: metric:met_orders_revenue      # a governed metric id
      member: Orders.revenue              # its member, for readability
    - ref: metric:met_orders_count
      member: Orders.order_count
    - ref: dataset:ds_orders_gold         # a governed dataset (for a table/pivot tile)
      view: Orders

  # ---- dashboard-level controls
  time:
    dimension: Orders.order_date
    range: last-28-days                   # human grammar; or {since, until}
    grain: day                            # day|week|month|quarter|year

  filters:                                # the native filter bar
    - id: f_region
      type: value                         # value | date-range | numeric-range | grain
      member: Orders.region
      multiple: true
      default: [DE]
      scope: all                          # all | [panel ids]
    - id: f_amount
      type: numeric-range
      member: Orders.amount
      default: { min: 0 }
      scope: [p_revenue_trend]

  # ---- panels (Superset's "charts"); each is self-contained, each names its own view
  panels:
    - id: p_revenue_kpi
      name: Total revenue
      viz: big_number
      metrics: [Orders.revenue]
      compare: previous-period
    - id: p_revenue_trend
      name: Revenue over time
      viz: line
      metrics: [Orders.revenue, Orders.order_count]
      timeDimension: Orders.order_date
      timeGrain: month
      stack: false
      limit: 10000
      orderBy: [{ member: Orders.order_date, direction: asc }]
    - id: p_by_region
      name: Revenue by region
      viz: bar
      metrics: [Orders.revenue]
      dimensions: [Orders.region]
      filters:
        - { member: Orders.channel, operator: in, values: [web, retail] }
      emitsCrossFilter: true
    - id: p_note
      name: How to read this
      viz: markdown
      markdown: |
        Revenue is **net of returns**. See the metric definition for the exact SQL.

  # ---- layout: tabs → rows → items (x/y/w/h on a 12-column grid)
  layout:
    tabs:
      - id: t_overview
        name: Overview
        rows:
          - items:
              - { panel: p_revenue_kpi, x: 0, y: 0, w: 4, h: 2 }
              - { panel: p_revenue_trend, x: 4, y: 0, w: 8, h: 2 }
          - items:
              - { panel: p_by_region, x: 0, y: 2, w: 8, h: 3 }
              - { panel: p_note, x: 8, y: 2, w: 4, h: 3 }
```

**Design rules behind it**

- **References are stable OS ids, not embedded queries.** `metric:<id>` / `dataset:<id>` means the governed layer stays the single definition of a number — the rule the tab already enforces ("a chart that references a raw dataset column rather than a governed `metric` member returns `bad_request`", `tabs/dashboards/guide.md`). A dashboard file can never smuggle SQL past the registry (R4).
- **Panels carry their own view**, so a dashboard can span data products (U1/D2) while the legacy top-level `view` keeps loading.
- **Byte-stable generation**, as the agent-system generator already guarantees (checklist item A3): sorted keys, deterministic ids, so regeneration produces no diff and `commitSubtree` commits only on real change (`core/infra/git-store.ts:13`).
- **One file, not a ZIP.** A dashboard is a *commit*, which is the portability story: `git log dashboards/sales-overview/` is the version history (complementing the in-OS `versionLog`, `lib/store.ts:325`), and the repo already exports as a tar (`GET /api/data/projects/<domain>/export`).

**Comparison**

| | Superset export | Perses | **Proposed OS format** |
|---|---|---|---|
| Unit | ZIP bundle | one YAML/JSON doc (`kind: Dashboard`) | one YAML doc per dashboard, in the domain repo |
| Files | `metadata.yaml` (`version: 1.0.0`) + `dashboards/*.yaml` + `charts/*.yaml` + `datasets/*.yaml` + `databases/*.yaml` | single spec | single spec + generated README + `index.yml` |
| References | **UUIDs** across files (`dataset_uuid`, `uuid`) | plugin `kind` + datasource refs | **stable OS ids** (`metric:…`, `dataset:…`) + the human member name |
| Layout | `position_json`: a tree of `ROOT/GRID/TABS/TAB/ROW/COLUMN/CHART/MARKDOWN/HEADER/DIVIDER` nodes with `meta.width/height` | `layouts[]` of grid items with `x/y/w/h` | `layout.tabs[].rows[].items[]` with `x/y/w/h` — Perses' readability, Superset's tabs |
| Chart config | `params` + `query_context` JSON **blobs** inside YAML | typed panel plugin spec | typed panel fields (no opaque blob) |
| Filters | `metadata.native_filter_configuration` (JSON blob) | `variables[]` | `spec.filters[]`, typed |
| Portability | import needs the same database/dataset UUIDs to exist | dashboard-as-code, CUE/Go/TS SDKs for authoring | git-native; import resolves metric/dataset ids in the target domain and **fails loudly** on a missing id |
| Human-editable | poorly (nested JSON-in-YAML) | yes | yes — the explicit goal |

Superset's format is the better *fidelity* model (it captures everything, including the database connection) and the worse *authoring* model (UUID cross-references and JSON blobs). Perses is the better authoring model. The proposal takes Perses' shape, Superset's layout vocabulary (tabs/rows, which Perses lacks), and the OS's own id discipline — and skips Superset's `datasets/`/`databases/` files entirely, because in the OS those are *already* governed artifacts with their own git home (`tabs/data/lib/dbt/`), so a dashboard references them rather than carrying copies.

---

## 5. User stories + requirements (numbered, testable)

Format mirrors the repo's `FEATURE: / USER STORY:` header discipline. Each has an explicit **Test** so "done" is a measurement.

**U1 — Build a dashboard from metrics and data products.**
As a creator I can create a dashboard whose panels bind to governed metric members **from more than one data product**, so a "Sales overview" can chart Orders *and* Marketing.
*Requirements:* `DashboardSpec.view` becomes optional/derived; each panel carries its own view (already true in the member prefix — `panel-query.ts:119`); the palette groups by view instead of filtering to one (`ui/PanelBuilder.tsx:156`).
*Test:* `unit` — a two-view spec round-trips through `fromTiles` and both panels resolve; `unit` — a legacy single-`view` spec is unchanged (back-compat, the module's existing discipline).

**U2 — Chart explore.**
As a creator I can configure a panel as metric(s) × up to 3 dimensions × time dimension × grain × filters × sort × row limit, switch viz type without losing the config, and **see the exact SQL** the panel will run before saving.
*Requirements:* extend `Panel` with `dimensions` (n>1), `orderBy`, `limit`; surface `PanelQueryResult.sql` (`panel-query.ts:44`) in the panel menu; filter operators beyond `equals` either implemented in `exploreSpec` **or** rejected at the type level (see U7).
*Test:* `unit` — a 2-dimension panel compiles to one `ExploreSpec` with both members and the grouped rows merge on `sliceKey`; `unit` — switching vizType preserves metrics/dimensions; `inspect` — the shown SQL equals `result.sql`.

**U3 — Native filter bar + cross-filter.**
As a viewer I get a filter bar above the dashboard with value, numeric-range, date-range and time-grain filters; a filter can be scoped to a subset of panels; clicking a datapoint cross-filters the dashboard; every filter lands in the governed **WHERE**, never a client-side re-slice.
*Requirements:* a `DashboardSpec.nativeFilters[]` model (id, type, target member(s), scope: all|panel ids, default value, dependency on another filter id); chips become one filter *type*; `exploreSpec` gains range + `in` + `not in`.
*Test:* `unit` — a range filter compiles to a `BETWEEN` in `previewTrinoSql`; `unit` — a filter scoped to panel A does not appear in panel B's spec; `unit` — a filter on a non-member is **dropped loudly** (`spec.dropped`), consistent with `explorer.ts:43-58`.

**U4 — Drill-down.**
As a viewer I click a bar/slice/KPI and get a drawer that re-queries the governed metric narrowed to that point, broken down by another dimension of the view, with an "Open in Metrics" backlink.
*Status:* **already satisfied** by `ui/DrillDrawer.tsx`. *Requirements:* extend to multi-level drill (a drill inside the drawer), and to a "drill to detail" row-level mode gated on the dataset's column-level entitlement.
*Test:* `unit` — the drawer's spec carries the clicked filter; `unit` — drill-to-detail on a `restricted` column is refused with a typed error, not silently blanked.

**U5 — Layout, tabs, markdown.**
As a creator I can drag and resize panels on a 12-column grid, group them into rows, add **tabs**, and add **markdown** and header tiles; the layout persists and the dashboard renders identically to another viewer.
*Requirements:* a layout tree (see §4.4 `layout:`), a drag/resize grid, `vizType: 'markdown' | 'header' | 'divider'` tiles (markdown reuses `core/ui/Markdown.tsx`, already present), `gridPos.x/y/h` honoured.
*Test:* `unit` — layout tree → rendered order is deterministic; `unit` — a spec with no layout falls back to today's flow layout (back-compat); `unit` — a markdown tile never produces a query.

**U6 — Sharing My → Domain → Company.**
*Status:* **already satisfied** (`lib/governance.ts`, `lib/store.ts:226`). *Requirement:* promotion must **refuse** a dashboard whose panels reference metrics of a *narrower* tier than the target (a Domain dashboard on a My-tier metric is a broken promise).
*Test:* `unit` — promote a dashboard whose panel cites a personal metric → refused with a typed reason naming the metric.

**U7 — Row-level security inherited from OPA/Trino.**
As a viewer of a shared or certified dashboard I see only my entitled rows; broadening the tier never broadens the rows; a panel never shows a number computed under another identity.
*Status:* **already satisfied and must be protected** (`panel-query.ts:114`, `identity.ts:132`).
*Requirements:* (a) any cache is keyed by principal **and** by the resolved Trino groups; (b) a non-`equals` filter operator must be a typed rejection, not a silent drop (`panel-query.ts:134-137` today); (c) scheduled snapshots render **per recipient**, never once-for-all.
*Test:* `unit` — two principals, same spec, different rows; `unit` — a cache hit for principal A is a miss for principal B; `unit` — `operator: '>='` returns a typed `bad_request` (new behaviour, replacing the silent drop).

**U8 — Export CSV / PNG / PDF.**
As a viewer I can export a panel's rendered rows as CSV, a panel as PNG, and the whole dashboard as PDF — each export carrying the viewer's identity and the filters applied.
*Requirements:* CSV exists per panel (`PanelChart.tsx:44-60`); add dashboard-wide CSV (one sheet per panel), PNG via `echartsInstance.getDataURL()`, PDF via the already-present `jspdf` + `jspdf-autotable`.
*Test:* `unit` — CSV of the rendered rows equals the governed result (no recomputation); `inspect` — the PDF footer names the viewer, the timestamp and the active filters.

**U9 — Schedules / snapshots.**
As an owner I schedule a dashboard snapshot daily/weekly/monthly; it is delivered in-app (the OS's one real channel) with a link and an attached PDF, rendered **as each recipient**.
*Requirements:* `lib/reports.ts` decides (already), `lib/delivery.ts` delivers (already), **the missing half is the render**. Two options: (a) in-process render in the os-ui worker; (b) a Dagster schedule (`tabs/data/lib/dbt/schedules.ts` already emits `os/schedules.yml`) that calls back into the OS. **(a) is recommended** — the worker already exists and a render needs the viewer's delegated token, which a Dagster job does not hold.
*Test:* `unit` — due-set logic (exists, `reports.test.ts`); `unit` — a snapshot for recipient B contains B's rows; `kind` — a scheduled report appears in the bell.

**U10 — MCP parity.**
As an agent I can do everything the UI can: `list_dashboards`, `get_dashboard`, `create_dashboard`, **`update_dashboard`** (patch name/layout/filters), **`add_chart`** / `remove_chart`, **`render_dashboard_data`** (the governed rows of every panel, as the caller), and the promote ladder via the existing `request_promotion` / `approve_promotion`.
*Requirements:* new write tools in `tabs/dashboards/mcp/dashboard-write-tools.ts`; `create_dashboard`'s `vizType` enum fixed to the full `VizType` union (today it omits `pie`/`area`/`big_number` — `:48`); `render_dashboard_data` reuses `runPanelQuery` per panel with the caller's delegated token.
*Test:* `mcp` — build a dashboard end-to-end through MCP only and read its numbers back; `unit` — `render_dashboard_data` for a principal who cannot see the dashboard is a typed `not_found`; `unit` — the alias-lint test (`core/mcp/alias-lint.test.ts:49`) covers the new names.

**U11 — Embedding in Software apps.**
As an app builder I can place a governed dashboard (or one panel) into a Software-tab app; it renders in-process under the viewer's identity — no iframe, no guest token.
*Requirements:* `core/ui/charts/` + a `<DashboardView spec rows>` shared component; an `appspec` renderer `DashboardEmbedRenderer` alongside `ChartExplorerRenderer`.
*Test:* `unit` — the same spec renders in both hosts from one component; `unit` — the embed resolves the viewer, not the app owner.

**U12 — Performance, caching, limits.**
A 20-panel dashboard opens in ≤3 s warm; panel queries are cached per `(principal, trinoGroups, panel spec, filters)` with a TTL; a dashboard has a configurable row limit per panel (default 10 000) and a per-open query budget; exceeding a budget is an honest warning, never a truncated-and-silent chart.
*Test:* `unit` — cache key includes the principal and the groups; `unit` — a truncated result sets `warning`; `kind` — 20 panels against the cluster under a stated budget.

**U13 — Dashboard-as-code in git.**
Every save of a dashboard is a **git commit** in the owning domain's repository under `dashboards/<slug>/dashboard.yaml`, authored as the acting user, with a message naming the action and its surface (`ui:dashboards` / `mcp:<tool>`) — exactly the A2 contract agent systems already meet.
*Requirements:* `reserveSubtree('dashboards/')` + `commitSubtree` (`core/infra/git-store.ts:289,499`); a generator mirroring `tabs/data/lib/dbt/generate.ts`; a reader so a repo checkout can be imported back.
*Test:* `unit` on the generator (golden files, as `tabs/agents/lib/git/generate.test.ts` does); `unit` — two saves = two commits in a real bare repo; `inspect` — a human can read the YAML and reconstruct the dashboard.

**U14 — Honest degradation (non-negotiable, exists today).**
A missing member, a dropped slice dimension, a stale domain table or a Trino outage produces a **loud warning and no number**, never a silently de-dimensioned chart or a fabricated value.
*Status:* satisfied (`panel-query.ts:184-212`, `model.ts:185`). *Requirement:* every new feature (cache, pivot, native filters, snapshots) must extend the same precedence chain, and the dropped-non-equality-filter hole must be closed.
*Test:* the existing tests plus one per new path.

---

## 6. Checklist items (repo style)

Companion to `docs/superpowers/plans/2026-11-13-engineering-checklist.md`. `Test` legend as in that file: `unit` · `kind` · `stackit` · `inspect` · `mcp`.

### Part D — Dashboards and data-product consumption

| # | Must be true | Test |
|---|---|---|
| D1 | There is exactly ONE chart rendering surface in the OS: `core/ui/charts/` owns the ECharts registration, the theme bridge and the formatters; `tabs/dashboards`, `tabs/data` and `tabs/software/appspec` all import it and register nothing of their own. | `inspect`: grep `from 'echarts` outside `core/ui/charts/` returns nothing; `unit`: the same spec renders identically in two hosts |
| D2 | A dashboard may chart metrics from MORE THAN ONE data product; each panel carries its own view, and a legacy single-`view` spec still loads unchanged. | `unit`: two-view spec round-trips; `unit`: the frozen legacy fixtures still parse |
| D3 | A panel's numbers come from the SAME compiled governed-SQL path as the Metrics explorer and `query_metric`, executed under the VIEWER's delegated identity — never a service account, never a cached other-principal result. | `unit`: two principals, same spec, different rows; `unit`: a non-delegated token throws; `inspect`: the only executor is `exploreMetric` |
| D4 | Dataset-backed (non-metric) tiles, if they exist at all, go through the governed `query_data` path with the same identity and the same loud-degradation contract. | `unit`; `inspect` |
| D5 | The dashboard has a real LAYOUT: a persisted tree of tabs → rows → panels with x/y/w/h; drag and resize write it; an absent layout falls back to today's flow order. | `unit`: layout → deterministic render order; `unit`: back-compat fallback |
| D6 | Markdown, header and divider tiles exist and never issue a query. | `unit` |
| D7 | A pivot table panel exists with row groupings, column groupings and subtotals, computed in SQL (or in a declared, tested post-processing step), not by the browser over partial rows. | `unit`: the compiled SQL/post-processing for a 2×2 pivot; `inspect` |
| D8 | A native filter BAR exists with value, numeric-range, date-range and time-grain filters; each filter declares its scope (all panels or named panels) and its default; every filter lands in the governed WHERE. | `unit` per filter type; `unit`: scoping; `unit`: a non-member filter is dropped LOUDLY |
| D9 | Cross-filtering and drill-down re-query the governed layer; no chart is ever re-sliced client-side from already-aggregated rows. | `unit`; `inspect`: no client-side group-by exists in the viewer |
| D10 | A filter operator the governed path cannot serve is a typed `bad_request`, never a silent under-filter. (Closes the `panel-query.ts:134-137` hole.) | `unit`: `operator:'>='` → typed error |
| D11 | Every save of a dashboard — UI or MCP — is a git commit under `dashboards/` in the owning domain's repo, authored as the acting user, message naming action + surface. | `unit` on the commit builder; `kind`: two saves → two commits with the right author |
| D12 | The committed `dashboard.yaml` is human-readable and round-trips: generate → read → generate is byte-stable, and a hand-edited file imports. | `unit` goldens (as `tabs/agents/lib/git/generate.test.ts`); `unit` round-trip |
| D13 | MCP parity: `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `add_chart`, `remove_chart`, `render_dashboard_data` all exist, all enforce the same visibility rule, and `create_dashboard`'s `vizType` enum equals the `VizType` union. | `mcp`: build + read a dashboard through MCP only; `unit`: enum equality tripwire; `unit`: unseeable id → typed not_found |
| D14 | `render_dashboard_data` returns the governed rows of every panel AS THE CALLER, with the same warnings the UI shows. | `unit` |
| D15 | Exports: per-panel CSV, dashboard CSV, panel PNG, dashboard PDF — each of the RENDERED governed rows, each naming the viewer, the time and the active filters. | `unit`: CSV equals the governed result; `inspect`: the PDF footer |
| D16 | A scheduled snapshot is rendered PER RECIPIENT under that recipient's identity, and delivered in-app; a recipient who lost entitlement gets nothing, not stale rows. | `unit`: per-recipient rows; `unit`: revoked recipient; `kind`: the bell |
| D17 | Query results may be cached only under a key that includes the principal AND the resolved Trino groups AND the full panel slice; a TTL is configurable; a cache miss is never an error. | `unit`: key composition; `unit`: A's hit is B's miss |
| D18 | A dashboard open has a stated query budget and per-panel row limit; exceeding either is an honest warning on the panel, never a silently truncated chart. | `unit`; `kind`: 20 panels inside the budget |
| D19 | Promotion refuses a dashboard whose panels cite metrics of a narrower tier than the target scope, naming the offending metric. | `unit` |
| D20 | A dashboard renders inside a Software-tab app from the same component, under the viewer's identity, with no iframe and no guest token. | `unit`; `inspect` |
| D21 | The bundled-Superset row is removed from `licenses/components.tsv` and the SBOM when the Superset chart is dropped; any VENDORED Superset source carries its original Apache-2.0 header, a "Modified by …" line, and is listed in `THIRD-PARTY-LICENSES.md`; `licenses/notices/Apache-Superset-NOTICE.txt` stays as long as any Superset-derived code ships. | `inspect`; `scripts/license-check.sh` green; `unit`: a header-presence tripwire over the vendored directory |
| D22 | No vendored dependency moves the OS off React 19 / Next 15, and `npm run check:licenses` still passes with the existing allowlist (no new SPDX id). | `inspect`: the lockfile diff; `scripts`: `npm run check:licenses` |
| D23 | `os-ui/vendor/**` is excluded from the `FEATURE:`/`USER STORY:`/`ARCHITECTURE:` header ratchet (ASF policy forbids rewriting third-party headers) and INCLUDED in a new ratchet asserting every file there retains an upstream licence header plus a `Modified from …` notice. | `inspect`; `unit`: the header tripwire over the vendored directory |
| D24 | `mapbox-gl` is pre-emptively on `licenses/denied-licenses.txt` (proprietary since v2.0, not expressible as a denied SPDX id) and no geospatial work introduces it; `maplibre-gl` (BSD-3-Clause) is the only map renderer permitted. | `inspect`; `scripts/license-check.sh` |

---

## 7. Risks

**R1 — Bundle size (high likelihood, medium impact).** Superset's own frontend is tens of MB; `@superset-ui/core` alone drags in `@emotion`, `antd`-era tokens, `d3-*`, `lodash`, `moment`/`dayjs` and a plugin registry. The OS's dashboards bundle today is "ECharts + 7 registered modules" by deliberate choice (`PanelChart.tsx:7-17`). *Mitigation:* vendor **source files**, not packages; add a bundle-size ratchet to CI (`@next/bundle-analyzer` is already a devDependency) and fail the build above a stated KB budget for `/dashboards`.

**R2 — React version incompatibility (high likelihood, high impact).** The repo is React **19.0.0** / Next **15.5.19** and has already paid this tax once: the custom ECharts wrapper exists specifically to dodge `echarts-for-react`'s peers (`PanelChart.tsx:8-9`). Superset's published packages target a React 16/17 era with `antd` and legacy context. *Mitigation:* treat every `@superset-ui` package as **source to read**, never a dependency to install (§2.2 — `@superset-ui/core@0.20.4` peers `react ^16.13.1`, frozen since 2024-12-10; even `master` targets React **18**, so Superset *components* are not drop-in either). If any install is ever attempted it must be behind a spike with `npm ls react` proving a single React copy. The same test kills `@perses-dev/*` (React ^18.3 + MUI 6) and `@grafana/scenes` (React-19-ready but drags the Grafana plugin runtime).

**R3 — Flask coupling (certain, low impact if respected).** Superset's dashboard and Explore code is woven into its Flask API shape: `/api/v1/chart/data` request/response envelopes, `query_context`, Redux stores keyed to Superset entities, `SupersetClient`, Jinja-templated datasets, and Superset's own RLS/permission model. Copying a React *container* drags that in. *Mitigation:* copy only **pure functions** — the ECharts option transformers, the layout algebra in `src/dashboard/util/`, the time-range grammar, the number/date formatters, the control-panel *taxonomy* — and re-implement every container against `ExploreSpec`. Note the trap that `SupersetClient` lives **inside** the package called `superset-ui-core` (`src/connection/`): "core" is not synonymous with "backend-free".

**R4 — Ad-hoc SQL is a governance hole (medium likelihood, HIGH impact).** Superset's power partly comes from adhoc SQL metrics and SQL Lab. In the OS, a panel that accepted raw SQL would bypass the metric registry, the member-entitlement resolver (`panel-query.ts:54-67`) and the "a chart that references a raw column returns `bad_request`" rule (`tabs/dashboards/guide.md`). *Mitigation:* **no adhoc SQL in panels.** Ad-hoc stays in the Data tab's governed `queryRun` path with OPA authorization (`core/infra/governed.ts:47`) and Trino-side RLS; the bridge is "promote this query to a metric", not "paste SQL into a tile".

**R5 — Cross-filter / native-filter complexity (high likelihood, medium impact).** Superset's filter system is genuinely hard: filter scoping per chart, inter-filter dependencies, filters that are themselves queries (value lists), time filters interacting with per-chart grains, and the chart↔filter emit/consume contract. Underbuilding gives a toy; overbuilding eats the budget. *Mitigation:* ship D8 in two steps — (i) value + date-range + grain filters scoped to "all panels" with defaults; (ii) per-panel scoping and dependencies — and keep every filter compiling to `ExploreSpec` so the governed WHERE stays the single enforcement point.

**R6 — Pivot table is deceptively expensive (medium/medium).** Superset's Pivot Table v2 is a third-party grid plus a post-processing pipeline (pandas, server-side). The OS has no post-processing layer and no pandas. *Mitigation:* implement the 2-dimension pivot **in SQL** (group by both, shape in `sqlRowsToExploreRows`), declare the limit honestly in the UI, and defer subtotals/%-of-total to a declared, tested post-processing module.

**R7 — Caching under per-viewer RLS (medium likelihood, CRITICAL impact).** A naive result cache is a data breach: the OS's whole dashboard story is "two viewers of the same dashboard see different rows" (`lib/governance.ts:13-15`). *Mitigation:* D17 — principal + resolved Trino groups in the key, and a tripwire test that a principal-less key cannot be constructed.

**R8 — Honesty regression (medium/high).** The existing loud-degradation machinery (`panel-query.ts:184-212`) is a competitive differentiator and is easy to lose in a rewrite — especially once caching, pivots and post-processing sit between the query and the pixels. *Mitigation:* D-items state it; keep `missingPanelMembers` / `missingMembersWarning` as the warning authority and route every new path through the same precedence.

**R9 — Trademark, not licence (low/medium).** Apache-2.0 §6 grants no trademark rights; "Apache Superset" is an ASF mark. The repo already handles this correctly (`NOTICE` lines 5-7: "not affiliated with, or endorsed by, the Apache Software Foundation"; `TRADEMARKS.md`; `core/kernel/licenses.ts:88`). *Mitigation:* describe the result as "Superset-inspired" / "includes code derived from Apache Superset", never "Superset-powered", and never ship a Superset logo.

**R10 — `mapbox-gl` is a licence landmine on the LATER map path (low likelihood now, high impact if hit).** `mapbox-gl` went **proprietary at v2.0** (Mapbox TOS, BSL-style) and is reachable through Superset's `legacy-plugin-chart-map-box` and deck.gl presets. Our gate would catch a *known* denied SPDX id, but a proprietary TOS is not an SPDX id — `licenses/denied-licenses.txt` matches strings like `BUSL`/`SSPL`, not "Mapbox Terms of Service". *Mitigation:* if geospatial charts are ever built, pin **`maplibre-gl` (BSD-3-Clause)**, and add `mapbox-gl` to `licenses/denied-licenses.txt` pre-emptively. Also avoid `nvd3` (Apache-2.0 but abandoned, d3 v3) and every `@superset-ui/legacy-plugin-chart-*` package — those directories have been **deleted from the monorepo**, so the npm packages are code the project itself abandoned.

**R11 — Scope collision with the v2-lean direction (medium/medium).** v2-lean removes Superset (and Dagster/Superset/OpenMetadata) from the bundle; `licenses/components.tsv:33` still lists `Superset chart 0.17.2 / app 6.1.0` as bundled. If the dashboards build lands while the Superset chart is still deployed, the OS ships two dashboard products. *Mitigation:* D21 ties the Superset chart's removal to this workstream's completion, in one change.
