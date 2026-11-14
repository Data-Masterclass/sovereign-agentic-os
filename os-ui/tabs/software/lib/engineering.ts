/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    `engineeringView('app', id)` — the Software tab's "Under the hood" adapter
 * USER STORY: As an engineer I want to see the REAL artefacts behind a vibe-engineered app in the
 *             tools' own vocabulary — the git repository and path, the head commit, the release
 *             tags, the files as committed, and the command I would run outside the OS — plus an
 *             honest statement of what the OS does NOT do for this app (night-2, decision D25).
 * ARCHITECTURE:
 *   - PURE + TYPED + MCP-SERIALISABLE: `appEngineeringView` takes a plain app descriptor and the
 *     git facts, and returns data. The I/O (reading git) is in `engineeringViewForApp`, so the
 *     shape is unit-tested without a repo.
 *   - The `EngineeringView` type is owned by `core/engineering/` (stream T). Until that module
 *     lands, this file declares the SAME shape locally and T re-points the import — recorded as a
 *     cross-stream dependency rather than creating another stream's folder.
 *   - VOCABULARY RULE: every label is the tool's own noun — "git repository", "commit", "annotated
 *     tag", "tree path" — with the OS term in parentheses once where a bridge is needed.
 *   - HONESTY SECTION: `notTrueYet` says, in the surface itself, what the OS does not do — there
 *     is no image builder, no CI runner and no registry, and Tier-3 containers are not built here.
 *     This is the `docs/components/trino.md` pattern, and it is the whole point of the view.
 */
import 'server-only';
import { listTags, logPath, type LogEntry, type TagEntry } from '@core/infra/git-store';
import { appSubtreePrefix, appProjectGitEnabled } from '@tabs/software/lib/git-commit';

/** One tab of the Under-the-hood panel, in a tool's own vocabulary. */
export type EngineeringTool = {
  /** The tool's own name, as an engineer says it. */
  tool: string;
  /** Short statement of what this tool owns for this object. */
  summary: string;
  /** Labelled facts — the tool's nouns, not OS-invented ones. */
  facts: { label: string; value: string }[];
  /** The command an engineer would run to do the same thing outside the OS. */
  commands: string[];
  /** A deep link, or null WITH a reason (never a link that cannot resolve). */
  link: { url: string; label: string } | null;
  linkUnavailableReason?: string;
};

/** The shared shape every kind's adapter returns (stream T owns the canonical type). */
export type EngineeringView = {
  kind: string;
  id: string;
  name: string;
  tools: EngineeringTool[];
  /** What the OS does NOT do for this kind — stated here, in its own words. */
  notTrueYet: string[];
  /** The native export and the command to use it elsewhere. */
  export?: { what: string; how: string };
};

export type AppEngineeringInput = {
  id: string;
  slug: string;
  name: string;
  domain?: string | null;
  serveMode: 'image' | 'runtime' | 'spec';
  /** The committed file paths, repo-relative to the app subtree. */
  files: string[];
  /** The app's commits, newest first (path-scoped to `apps/<slug>`). */
  history: Pick<LogEntry, 'sha' | 'subject' | 'author' | 'timestamp'>[];
  /** The release tags for this app, newest first. */
  releases: Pick<TagEntry, 'name' | 'commit' | 'timestamp'>[];
  /** The app's MCP principal (`app-<slug>`), which is what a trace is filed under. */
  mcpPrincipal: string;
  /** False ⇒ the domain repository is switched off; say so rather than show an empty history. */
  gitEnabled: boolean;
};

const SERVE_MODE_SUMMARY: Record<AppEngineeringInput['serveMode'], string> = {
  spec: 'A validated AppSpec rendered same-origin by the OS renderer under the viewer’s session — no container, no registry, no pod.',
  runtime: 'The committed Vite tree, bundled by the OS and mounted in a sandboxed same-origin iframe — no container, no registry, no pod.',
  image: 'A container image the OPERATOR built and published, served by a per-app Deployment+Service+Ingress. The OS does not build it.',
};

/** Pure: the Under-the-hood view for one app. No I/O. */
export function appEngineeringView(input: AppEngineeringInput): EngineeringView {
  const domain = String(input.domain ?? '').trim();
  const path = `${appSubtreePrefix(input.slug)}/`;
  const head = input.history[0];

  const git: EngineeringTool = {
    tool: 'git',
    summary: domain
      ? `The app’s source tree is a subtree of the ${domain} domain’s bare repository on the os-repos volume.`
      : 'The app is not assigned to a domain, so it has no domain repository yet.',
    facts: [
      { label: 'repository', value: domain ? `/repos/${domain}.git` : '(none — the app has no domain)' },
      { label: 'branch', value: 'main (the only long-lived ref)' },
      { label: 'tree path', value: path },
      { label: 'head commit', value: head ? head.sha : input.gitEnabled ? '(no commit yet)' : '(the domain repository is disabled)' },
      { label: 'head subject', value: head ? head.subject : '—' },
      { label: 'head author', value: head ? `${head.author.name} <${head.author.email}>` : '—' },
      { label: 'tracked files', value: String(input.files.length) },
      { label: 'commits touching this app', value: String(input.history.length) },
    ],
    commands: [
      `git --git-dir=/repos/${domain || '<domain>'}.git log --oneline -- ${path}`,
      `git --git-dir=/repos/${domain || '<domain>'}.git show ${head ? head.sha : 'main'}:${path}app.yaml`,
      `git clone https://<os>/git/${domain || '<domain>'}.git`,
    ],
    link: null,
    linkUnavailableReason:
      'The domain repository is served inside the cluster (a read-only `git daemon` on the os-ui pod and, once the engineer’s door lands, authenticated git over HTTP). There is no web UI to link to — clone it instead.',
  };

  const releases: EngineeringTool = {
    tool: 'git (annotated tags)',
    summary: 'A release is an immutable annotated tag `app/<slug>/v<MAJOR>.<MINOR>.<PATCH>` on the reviewed commit.',
    facts:
      input.releases.length > 0
        ? input.releases.map((r) => ({ label: r.name, value: r.commit.slice(0, 12) }))
        : [{ label: 'releases', value: '(none — this app has no release tag yet)' }],
    commands: [`git --git-dir=/repos/${domain || '<domain>'}.git tag --list 'app/${input.slug}/v*'`],
    link: null,
    linkUnavailableReason: 'Tags live in the domain repository; clone it to read them.',
  };

  const serving: EngineeringTool = {
    tool: 'Kubernetes',
    summary: SERVE_MODE_SUMMARY[input.serveMode],
    facts: [
      { label: 'serve mode', value: input.serveMode },
      ...(input.serveMode === 'image'
        ? [
            { label: 'namespace', value: 'agentic-apps' },
            { label: 'objects', value: `Deployment/Service/Ingress app-${input.slug}` },
          ]
        : [{ label: 'objects', value: '(none — the OS serves this app itself, same-origin)' }]),
    ],
    commands:
      input.serveMode === 'image'
        ? [`kubectl -n agentic-apps get deploy,svc,ing app-${input.slug}`]
        : [`curl -s https://<os>/apps/${input.slug}`],
    link: input.serveMode === 'image' ? null : { url: `/apps/${input.slug}`, label: `/apps/${input.slug}` },
    ...(input.serveMode === 'image'
      ? { linkUnavailableReason: 'An image app is served at its own host, not by the OS route.' }
      : {}),
  };

  const langfuse: EngineeringTool = {
    tool: 'Langfuse',
    summary: 'Every agent→app tool call is one Langfuse trace filed under the app’s principal, carrying the policy decision.',
    facts: [
      { label: 'principal', value: input.mcpPrincipal },
      { label: 'decisions traced', value: 'allow · requires_approval (held) · deny' },
    ],
    commands: [`curl -fsS -H "Authorization: Bearer $LANGFUSE_PUBLIC_KEY" "https://<langfuse>/api/public/traces?userId=${input.mcpPrincipal}"`],
    link: null,
    linkUnavailableReason: 'The trace link needs a trace id — open one from the run that made the call.',
  };

  return {
    kind: 'app',
    id: input.id,
    name: input.name,
    tools: [git, releases, serving, langfuse],
    notTrueYet: [
      'The OS does NOT build container images. There is no image builder, no CI runner and no container registry in this stack; an `image` app serves an image the operator built and published, and a missing image fails closed.',
      'There is no GitOps controller: nothing reverts drift automatically.',
      'Release tags exist as a git API; `release_software` (the verb that writes `release.json` and creates the tag) and the gate set behind it are not built yet.',
      ...(input.gitEnabled ? [] : ['The domain git repository is switched off (DATA_PROJECT_GIT=false), so this app’s history is not being recorded.']),
    ],
    export: {
      what: `the app’s source tree (${path}) plus its release manifest, as committed`,
      how: `git --git-dir=/repos/${domain || '<domain>'}.git archive ${head ? head.sha : 'main'} ${path} | tar -x`,
    },
  };
}

/** Read the git facts and build the view. The adapter stream T's registry calls. */
export async function engineeringViewForApp(
  app: { id: string; slug: string; name: string; domain?: string | null; serveMode: 'image' | 'runtime' | 'spec'; mcpPrincipal: string },
  committedFiles: string[],
): Promise<EngineeringView> {
  const domain = String(app.domain ?? '').trim();
  const gitEnabled = appProjectGitEnabled();
  let history: AppEngineeringInput['history'] = [];
  let releases: AppEngineeringInput['releases'] = [];
  if (gitEnabled && domain) {
    try {
      const log = await logPath(domain, appSubtreePrefix(app.slug), { limit: 20 });
      history = log.entries.map((e) => ({ sha: e.sha, subject: e.subject, author: e.author, timestamp: e.timestamp }));
    } catch {
      history = [];
    }
    try {
      releases = (await listTags(domain, `app/${app.slug}/v`)).map((t) => ({ name: t.name, commit: t.commit, timestamp: t.timestamp }));
    } catch {
      releases = [];
    }
  }
  return appEngineeringView({ ...app, domain, files: committedFiles, history, releases, gitEnabled });
}
