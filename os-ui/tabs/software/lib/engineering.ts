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
 *   - NIGHT-2 MERGE (T x S). S's own `engineering.ts` is replaced by this one, as the brief
 *     directs: T's `(principal, id)` adapter signature and `@core/engineering/types` are kept, and
 *     `committed` is derived from the REAL `apps/<slug>/` subtree. What S had that T did not is
 *     ported in: the subtree prefix comes from S's `appSubtreePrefix` (so the literal cannot
 *     drift from the writer's), the release tags are read through S's `listTags`, and S's four
 *     "not true yet" sentences are carried as git-section caveats. S's Kubernetes section is NOT
 *     reproduced: `ENGINEERING_TOOLS` is a closed set and `kubernetes` is not in it, so the serve
 *     mode is stated as a caveat rather than invented as a tool.
 */
import 'server-only';
import { getAppForUser, listAppFilesForViewer } from '@tabs/software/lib/apps';
import { appSubtreePrefix, appProjectGitEnabled, APPS_PREFIX as WRITER_APPS_PREFIX } from '@tabs/software/lib/git-commit';
import { listTags } from '@core/infra/git-store';
import { repoPaths } from '@core/engineering/repo';
import { dagsterSection, dbtSection, gitSection, langfuseSection, LANGFUSE_REDACTIONS } from '@core/engineering/sections';
import { sealView, type EngineeringPrincipal, type EngineeringView } from '@core/engineering/types';

const OS_NOUN = 'app';
/**
 * The subtree an app's source tree lives in. NIGHT-2 MERGE: re-exported from S's writer
 * (`tabs/software/lib/git-commit.ts`) rather than restated, so this view and
 * `commitSubtree('apps/<slug>')` cannot name two different prefixes.
 */
export const APPS_PREFIX = WRITER_APPS_PREFIX;

/** The serve mode, in the words of what actually runs — S's text, kept. */
const SERVE_MODE_SUMMARY: Record<string, string> = {
  spec: 'A validated AppSpec rendered same-origin by the OS renderer under the viewer\u2019s session — no container, no registry, no pod.',
  runtime: 'The committed Vite tree, bundled by the OS and mounted in a sandboxed same-origin iframe — no container, no registry, no pod.',
  image: 'A container image the OPERATOR built and published, served by a per-app Deployment+Service+Ingress. The OS does not build it.',
};

/** The engineering view of one app. */
export async function appEngineeringView(principal: EngineeringPrincipal, id: string): Promise<EngineeringView> {
  const app = await getAppForUser(id, principal);
  const domain = app.domain;
  const dir = appSubtreePrefix(app.slug);
  const gitEnabled = appProjectGitEnabled();

  const listed = await repoPaths(domain);
  const committed = listed.paths.filter((p) => p.startsWith(`${dir}/`)).sort();
  let mirrored: string[] = [];
  let mirrorError: string | null = null;
  try {
    mirrored = (await listAppFilesForViewer(app.id, principal)).files.slice().sort();
  } catch (e) {
    mirrorError = (e as Error).message;
  }

  let releases: { name: string; commit: string }[] = [];
  let releasesError: string | null = null;
  if (gitEnabled && domain) {
    try {
      releases = (await listTags(domain, `app/${app.slug}/v`)).map((t) => ({ name: t.name, commit: t.commit }));
    } catch (e) {
      releasesError = (e as Error).message;
    }
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
        ? gitEnabled
          ? `\`${dir}/\` is not committed in '${domain}', so there is no head commit, no history and no diff for this app's source yet — nothing has been pushed through the writer's \`commitSubtree('${dir}')\` path. The OS holds ${mirrored.length} file(s) of it in its own durable file mirror (the \`os-app-files\` index), which is a CACHE of the committed tree and not the record.`
          : `the domain git repository is switched off in this deployment (DATA_PROJECT_GIT=false), so nothing is being committed for this app at all. The OS holds ${mirrored.length} file(s) of it in its own durable file mirror (the \`os-app-files\` index).`
        : undefined,
    caveats: [
      // S's serve-mode sentence: what actually runs, in its own words.
      SERVE_MODE_SUMMARY[String(app.serveMode ?? '')] ??
        `The serve mode of this app is \`${String(app.serveMode ?? '(unset)')}\`, which the OS has no description for — it is not one of spec / runtime / image.`,
      ...(mirrorError ? [`The OS file mirror could not be read: ${mirrorError}`] : []),
      ...(committed.length === 0 && mirrored.length
        ? [`The files the OS holds today, in the mirror rather than in git: ${mirrored.slice(0, 20).join(', ')}${mirrored.length > 20 ? `, … (${mirrored.length} in total)` : ''}.`]
        : []),
      ...(committed.length > 0 && mirrored.length && mirrored.length !== committed.length
        ? [`The OS file mirror holds ${mirrored.length} file(s) for this app and the repository tracks ${committed.length} under \`${dir}/\`; the repository is the record, and a difference means the mirror is behind.`]
        : []),
      // S's release tags: read, never asserted. An empty list is said plainly.
      releases.length
        ? `Releases are immutable annotated tags \`app/${app.slug}/v<MAJOR>.<MINOR>.<PATCH>\`; this app has ${releases.length}: ${releases.map((r) => `${r.name} -> ${r.commit.slice(0, 12)}`).join(', ')}.`
        : `A release is an immutable annotated tag \`app/${app.slug}/v<MAJOR>.<MINOR>.<PATCH>\` on the reviewed commit. This app has none yet${releasesError ? ` (the tag read failed: ${releasesError})` : ''}.`,
      // S's "not true yet", carried verbatim in substance.
      'The OS does NOT build container images. There is no image builder, no CI runner and no container registry in this stack; an `image` app serves an image the operator built and published, and a missing image fails closed.',
      'There is no GitOps controller: nothing reverts drift automatically.',
      'Release tags exist as a git API; `release_software` — the verb that writes a release manifest and creates the tag — is not built yet, so no tag can be created from the OS tonight.',
    ],
  });
  git.commands.push({
    tool: 'git',
    command: `git tag --list 'app/${app.slug}/v*'`,
    description: 'the release tags of this app, in a checkout of the domain repository',
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
          ? `\`${dir}/\` is not in git yet, so there is nothing to archive; read the source file by file with \`read_app_files\` over the MCP, and \`push_app_files\` is what puts it in git`
          : 'a one-click archive of the subtree is not built yet; a `git clone` of the domain repository contains it',
      commands: [`git clone <os>/git/${domain}.git`, `ls ${dir}`],
    },
  }, new Set(listed.paths));
}
