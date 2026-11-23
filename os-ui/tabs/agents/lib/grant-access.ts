/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Tell the builder, when they save or build, which granted resources they cannot use
 * USER STORY: As a student building an agent team I granted a dataset id that turned out to be
 *             private to someone else. I want to be told that when I save or build — not find
 *             out when the run fails — and I want to be told what to do about it, without the
 *             OS telling me anything about a dataset I am not allowed to see.
 * ARCHITECTURE:
 *   - A WARNING, never a gate. Access can change after the yaml is written (the owner shares the
 *     dataset tomorrow), so saving and building still succeed; the run-time check
 *     (`build/grant-scope.ts` + the governed door, as the runner) stays the only enforcement.
 *   - PURE classification. The one input that needs the stores is a {@link GrantProbe}: "can the
 *     ACTING user see this id, and if so where does it live". The server probe
 *     (`build/grant-access-probe.ts`) answers it through the governed MCP door with the SAME
 *     `get_*` tool an agent of the team would call — so the canView/DLS rule applied is the
 *     tab's own rule, never a copy (a tab may not import another tab's store).
 *   - Folder grants need no probe: a `personal` folder is always the actor's own tree; a
 *     `domain` folder is reachable only for a member of the team's domain.
 *   - NO LEAK. A message about an id the user cannot see names nothing but the id they wrote
 *     themselves and the team's own domain — never the resource's name, owner or home domain.
 */
import { inDomainScope } from '@core/kernel/domain-scope';
import type { ArtifactGrant, Capability, FolderGrantTarget, System } from '@tabs/agents/lib/system-schema';

/** The grant lists whose item ids name a governed artifact the check can resolve. */
export type GrantCheckKind = 'data' | 'knowledge' | 'workflows' | 'files' | 'metrics' | 'connections';
export const GRANT_CHECK_KINDS: readonly GrantCheckKind[] = ['data', 'knowledge', 'workflows', 'files', 'metrics', 'connections'];

/**
 * The verdict for ONE grant, from the acting user's point of view:
 *  - `ok`             — they can see it (and it is in the team's domain, or a marketplace item).
 *  - `not-visible`    — it exists but they cannot see it (private to someone else, or shared to
 *                       a domain they are not in); for a folder grant: a Domain folder of a
 *                       domain they are not a member of.
 *  - `not-found`      — no such id (deleted, or mistyped). Some tabs answer "not found" for an
 *                       unseeable id too, so the message says both.
 *  - `outside-domain` — they can see it, but it is homed in another domain than the team's.
 */
export type GrantAccessStatus = 'ok' | 'not-visible' | 'not-found' | 'outside-domain';

/** What the probe learned about one id, as the acting user. */
export type ProbeResult =
  | { status: 'visible'; domain?: string | null; marketplace?: boolean }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  /** An outage or an answer the probe cannot read — says nothing rather than guess. */
  | { status: 'unknown' };

export type GrantProbe = (kind: GrantCheckKind, id: string) => Promise<ProbeResult>;

/** One grant that is not `ok` — what the save/build/MCP responses carry as `grantWarnings`. */
export type GrantWarning = {
  kind: GrantCheckKind;
  /** The item id (absent on a folder grant). */
  id?: string;
  folder?: FolderGrantTarget;
  capability: Capability;
  status: Exclude<GrantAccessStatus, 'ok'>;
  /** One sentence for the builder: what is wrong and what to do. Never names a hidden resource. */
  message: string;
};

/** The acting user, as far as the check needs it. */
export type GrantActor = { domains: string[] };

const NOUN: Record<GrantCheckKind, string> = {
  data: 'dataset',
  knowledge: 'knowledge note',
  workflows: 'workflow',
  files: 'file',
  metrics: 'metric',
  connections: 'connection',
};

/** `a dataset` / `an …` — for the sentences below. */
function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** The team's domain as a sentence fragment — the only domain a message ever names. */
function domainPhrase(systemDomain: string | null): string {
  return systemDomain ? `the ${systemDomain} domain` : 'your domain';
}

/**
 * The builder-facing sentence for one verdict. Deliberately built from the kind, the
 * team's domain and nothing else: a `not-visible` id may belong to anyone, and the user
 * must learn no more about it than that they cannot see it.
 */
export function grantAccessMessage(
  kind: GrantCheckKind,
  status: Exclude<GrantAccessStatus, 'ok'>,
  systemDomain: string | null,
  opts: { folder?: FolderGrantTarget } = {},
): string {
  const noun = NOUN[kind];
  const where = domainPhrase(systemDomain);
  if (opts.folder) {
    // The only folder verdict is "a Domain folder of a domain you are not in".
    return (
      `You can't use this Domain folder (${opts.folder.path}) — you are not a member of ${where}, ` +
      `so the team can't read or write it when you run it. Ask a domain admin to add you to ${where}, or grant one of your own folders.`
    );
  }
  switch (status) {
    case 'not-visible':
      return (
        `You can't see this ${noun} — it is private to its owner or not shared with your domain. ` +
        `Ask the owner to share it to ${where}. Until then the team will be refused when it tries to use it.`
      );
    case 'not-found':
      return (
        `No ${noun} with this id exists that you can see — it may have been deleted, or the id is wrong. ` +
        `Remove the grant, or pick ${article(noun)} from the list.`
      );
    case 'outside-domain':
      return (
        `This ${noun} lives in another domain than this team (${systemDomain ?? 'no domain'}). ` +
        `It works when you run the team, but other members of ${where} may not be able to see it — share it to ${where} or pick one from this domain.`
      );
  }
}

/** Classify one item grant from what the probe saw. `null` ⇒ nothing to say (ok or unknown). */
export function classifyProbe(probe: ProbeResult, systemDomain: string | null): GrantAccessStatus | null {
  switch (probe.status) {
    case 'forbidden':
      return 'not-visible';
    case 'not_found':
      return 'not-found';
    case 'unknown':
      return null;
    case 'visible':
      // The SAME predicate the grant picker narrows by: a marketplace item or a domainless one
      // is in scope anywhere; otherwise the item's home domain must be the team's.
      return inDomainScope({ scope: probe.marketplace ? 'marketplace' : 'domain', domain: probe.domain ?? null }, systemDomain)
        ? 'ok'
        : 'outside-domain';
  }
}

/** A folder grant's verdict. Personal ⇒ always the actor's own tree. */
export function classifyFolder(folder: FolderGrantTarget, actor: GrantActor, systemDomain: string | null): GrantAccessStatus {
  if (folder.scope !== 'domain') return 'ok';
  // A domainless team resolves a Domain folder against the runner's own domains — nothing to say.
  if (!systemDomain) return 'ok';
  return actor.domains.includes(systemDomain) ? 'ok' : 'not-visible';
}

/** An enabled grant — `Off`/`Blocked` grant nothing, so they are never worth a warning. */
function enabled(g: ArtifactGrant): boolean {
  return g.capability !== 'Off' && g.capability !== 'Blocked';
}

/**
 * Every grant of `sys` that the ACTING user cannot use as granted. Probes run in parallel; a
 * probe that throws counts as `unknown` (no warning) — this check must never break a save.
 * Order is stable: kind order, then the grant's order in the yaml.
 */
export async function checkGrantAccess(actor: GrantActor, sys: System, probe: GrantProbe): Promise<GrantWarning[]> {
  const systemDomain = sys.system.domain || null;
  const jobs: Promise<GrantWarning | null>[] = [];
  for (const kind of GRANT_CHECK_KINDS) {
    for (const g of (sys.grants[kind] ?? []) as ArtifactGrant[]) {
      if (!enabled(g)) continue;
      if (g.folder) {
        const status = classifyFolder(g.folder, actor, systemDomain);
        jobs.push(Promise.resolve(status === 'ok' ? null : {
          kind, folder: g.folder, capability: g.capability, status,
          message: grantAccessMessage(kind, status, systemDomain, { folder: g.folder }),
        }));
        continue;
      }
      const id = (g.id ?? '').trim();
      if (!id) continue;
      jobs.push(
        probe(kind, id)
          .catch((): ProbeResult => ({ status: 'unknown' }))
          .then((p) => {
            const status = classifyProbe(p, systemDomain);
            if (!status || status === 'ok') return null;
            return { kind, id, capability: g.capability, status, message: grantAccessMessage(kind, status, systemDomain) };
          }),
      );
    }
  }
  return (await Promise.all(jobs)).filter((w): w is GrantWarning => w !== null);
}

/** `kind:id` (or `kind:folder:<scope>:<path>`) — how the UI looks a warning up next to its grant. */
export function grantWarningKey(w: Pick<GrantWarning, 'kind' | 'id' | 'folder'>): string {
  return w.folder ? `${w.kind}:folder:${w.folder.scope}:${w.folder.path}` : `${w.kind}:${w.id ?? ''}`;
}
