/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Hermes skills → governed artifacts (hermes-agent-integration-plan.md §6).
 *
 * A Hermes-created skill (agentskills.io open standard) is NOT auto-trusted: it
 * surfaces as a REVIEWABLE artifact (owner · domain · visibility) at Personal
 * visibility, exactly like a drafted knowledge doc. A Creator/Builder reviews it;
 * only then can it be promoted/certified into the Marketplace. Skills Guard scans
 * before install; our review gate stays. This bridge is the mapping + the guard.
 *
 * Memory + skills persist to a per-user, backed-up, DELETABLE volume (the chart's
 * hermes memory PVC, Velero-backed per backup-strategy.md); `skillStoragePath`
 * and `deletionPlan` express that here so the gate can assert it without a cluster.
 *
 * PURE module (no server-only): `lib/artifacts.ts` persists the returned artifact.
 */

import type { Artifact } from '../core/artifact-model.ts';

export type HermesSkill = {
  /** Skill id (agentskills.io slug). */
  id: string;
  name: string;
  description: string;
  /** The skill body (instructions/code) — scanned by Skills Guard before trust. */
  body: string;
  /** The Hermes profile (user) that authored it. */
  author: string;
  domain: string;
};

/** A skill artifact. Created UNCERTIFIED (Personal); `certified` only ever flips
 *  true through the human promotion ladder (never auto). */
export type SkillArtifact = Artifact & { type: 'skill'; certified: boolean };

function id(): string {
  return `skill_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Map a Hermes-created skill to a reviewable, UNCERTIFIED artifact. Visibility is
 * always 'Personal' (owner-only, in-domain) — never Shared/Certified — so the
 * human promotion ladder is mandatory. Origin is 'authored'.
 */
export function skillToArtifact(skill: HermesSkill): SkillArtifact {
  const now = new Date().toISOString();
  return {
    id: id(),
    type: 'skill',
    name: skill.name,
    description: skill.description,
    owner: skill.author,
    domain: skill.domain,
    visibility: 'Personal', // uncertified — must be reviewed then promoted
    origin: 'authored',
    certified: false,
    spec: { skillId: skill.id, body: skill.body, source: 'hermes' },
    tags: ['hermes-skill', 'reviewable', 'uncertified'],
    createdAt: now,
    updatedAt: now,
  };
}

/** True only for a fully-promoted skill; a fresh Hermes skill is never certified. */
export function isCertified(a: SkillArtifact): boolean {
  return a.visibility === 'Certified' && a.certified === true;
}

// ------------------------------------------------------------- Skills Guard scan --

const DANGEROUS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\bcurl\b[^\n]*\|\s*(?:ba)?sh\b/i, why: 'pipes a download into a shell' },
  { re: /\beval\s*\(/i, why: 'uses eval()' },
  { re: /\brm\s+-rf\s+\//i, why: 'destructive filesystem command' },
  { re: /\b(?:AKIA|sk-[a-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b/, why: 'embeds a hard-coded credential' },
  { re: /169\.254\.169\.254|metadata\.google\.internal/i, why: 'targets cloud metadata (SSRF)' },
];

export type GuardResult = { clean: boolean; findings: string[] };

/** Skills Guard: scan a skill body BEFORE it may be installed/promoted. */
export function skillsGuardScan(skill: HermesSkill): GuardResult {
  const findings: string[] = [];
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(skill.body)) findings.push(why);
  }
  return { clean: findings.length === 0, findings };
}

// ------------------------------------------- memory/skills persistence (governed) --

export type SkillStorage = {
  /** Per-user prefix on the backed-up volume — never shared. */
  path: string;
  /** Velero-backed per backup-strategy.md. */
  backedUp: true;
  /** Honcho user-modeling = personal data → GDPR/RLS: must be deletable. */
  deletable: true;
};

/** The per-user, backed-up, deletable storage location for memory + skills. */
export function skillStoragePath(user: string): SkillStorage {
  const slug = user.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return { path: `hermes-memory/${slug}/`, backedUp: true, deletable: true };
}

/** The deletion plan for a user's Hermes memory+skills (GDPR erasure). */
export function deletionPlan(user: string): { path: string; recursive: true; audited: true } {
  return { path: skillStoragePath(user).path, recursive: true, audited: true };
}
