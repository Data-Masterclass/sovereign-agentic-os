/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The Software tab's engineering view — the app's source tree, and what is NOT in git yet
 * USER STORY: As an engineer I open "Under the hood" on an app and see its source files and where
 *             they REALLY live: the `apps/<slug>/` subtree of the domain repository once the app
 *             writer commits there, and otherwise the OS's own file mirror — said plainly, rather
 *             than implying a git story that does not hold yet (checklist T6, T7).
 * ARCHITECTURE:
 *   - `getAppForUser` first — it answers 404 for an app the caller cannot see, which is the
 *     software tab's uniform refusal (no existence leak), and the MCP maps it to `not_found`.
 *   - Everything is DERIVED from the tracked paths of the domain repository, never asserted: when
 *     `apps/<slug>/` is committed the git section shows those files and says nothing about a
 *     mirror; when it is not, it says so and names the mirror the bytes are in. Both states are
 *     tested, so the stream that lands the commit path changes no code here.
 *   - The git section carries NO artefact it cannot source from git (`tracked` is passed to
 *     `gitSection` and to `sealView`, which both refuse a path the repository does not track).
 */
import 'server-only';
import { getAppForUser, listAppFilesForViewer } from '@tabs/software/lib/apps';
import { repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';

const OS_NOUN = 'app';
/** The subtree an app's source tree is destined for (`commitSubtree('apps/<slug>')`). */
export const APPS_PREFIX = 'apps/';

/** The engineering view of one app. */
export async function appEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const app = await getAppForUser(id, principal);
  const domain = app.domain;
  const dir = `${APPS_PREFIX}${app.slug}`;

  const listed = await repoPaths(domain);
  const committed = listed.paths.filter((p) => p.startsWith(`${dir}/`)).sort();
  let mirrored: string[] = [];
  let mirrorError: string | null = null;
  try {
    mirrored = (await listAppFilesForViewer(app.id, principal)).files.slice().sort();
  } catch (e) {
    mirrorError = (e as Error).message;
  }

  const git = gitSection({
    osNoun: OS_NOUN,
    repo: domain,
    cloneUrl: null,
    head: listed.head,
    files: committed.map((p) => ({ path: p })),
    tracked: new Set(listed.paths),
    unavailable:
      committed.length === 0
        ? `\`${dir}/\` is not committed in '${domain}', so there is no head commit, no history and no diff for this app's source yet: the OS holds ${mirrored.length} file(s) of it in its own durable file mirror (the \`os-app-files\` index) instead. The app writer's \`commitSubtree('${dir}')\` path is what replaces that.`
        : undefined,
    caveats: [
      ...(mirrorError ? [`The OS file mirror could not be read: ${mirrorError}`] : []),
      ...(committed.length === 0 && mirrored.length
        ? [`The files the OS holds today, in the mirror rather than in git: ${mirrored.slice(0, 20).join(', ')}${mirrored.length > 20 ? `, … (${mirrored.length} in total)` : ''}.`]
        : []),
      ...(committed.length > 0 && mirrored.length && mirrored.length !== committed.length
        ? [`The OS file mirror holds ${mirrored.length} file(s) for this app and the repository tracks ${committed.length} under \`${dir}/\`; the repository is the record, and a difference means the mirror is behind.`]
        : []),
    ],
  });

  const dbt = dbtSection({
    osNoun: OS_NOUN,
    node: null,
    files: [],
    unavailable:
      'an app is not a dbt project; the data products it consumes are dbt models, each on its own panel, and the app reads them as the signed-in user through the governed query path',
    caveats: app.consumes?.length
      ? [`This app consumes ${app.consumes.length} governed resource(s); each one keeps its own engineering view.`]
      : undefined,
  });
  const dagster = dagsterSection({
    osNoun: OS_NOUN,
    facts: { assetKeys: [], jobName: null, scheduleName: null, lastRun: null, uiBaseUrl: null },
    unavailable: 'an app is served, not materialised — Dagster schedules dbt models, not application containers',
  });
  const langfuse = langfuseSection({
    osNoun: OS_NOUN,
    traces: [],
    enabled: false,
    unavailable:
      'an app call is traced only when it calls an OS agent: that run keeps its own Langfuse trace on the agent system\'s panel, under the run id the app was given',
    redactions: LANGFUSE_REDACTIONS,
  });

  return sealView({
    kind: 'app',
    id: app.id,
    name: app.name,
    domain,
    sections: [dbt, dagster, git, langfuse],
    export: {
      tool: 'git',
      label: 'the git tree of the app source',
      href: null,
      unresolvedReason:
        committed.length === 0
          ? `\`${dir}/\` is not in git yet, so there is nothing to archive; read the source file by file with \`read_app_files\` over the MCP until the commit path lands`
          : 'a one-click archive of the subtree is not built yet; a `git clone` of the domain repository contains it',
      commands: [`git clone <os>/git/${domain}.git`, `ls ${dir}`],
    },
  }, new Set(listed.paths));
}
