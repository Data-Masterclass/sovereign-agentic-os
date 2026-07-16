/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { allArtifacts } from '@/lib/core/artifacts';
import { listUsers } from '@/lib/platform-admin';
import type { Role } from '@/lib/core/session';
import { type ArtifactKind, ARTIFACT_KINDS } from '@/lib/strategy/model';
import {
  tallyAdoption,
  type AdoptionBoard,
  type DomainAdoption,
  type TierCounts,
} from '@/lib/strategy/adoption-core';

/**
 * Adoption-metrics adapter — the LIVE scoreboard (Opus-owned derivation).
 *
 * Promoted/certified counts are derived live from the artifact registry +
 * OpenMetadata (visibility tier = promoted/certified) BY DOMAIN — never
 * hand-kept. Active Creators & Builders are derived from recent authoring
 * activity (registry + audit), joined to the user directory for the role split.
 * Because both read the same registry the rest of the OS writes to, certifying a
 * data product makes its count increment with NO manual edit — exactly the gate's
 * live-adoption proof. The pure reduction lives in `adoption-core.ts`; this module
 * just supplies the live registry + roster.
 */

const ACTIVE_WINDOW_DAYS = 90;

export type { AdoptionBoard, DomainAdoption, TierCounts };

/**
 * Compute the live adoption board across all domains. Optionally restrict to a
 * single domain (for a domain pillar's scoreboard).
 */
export async function adoptionBoard(domainFilter?: string, viewerId?: string): Promise<AdoptionBoard> {
  const [arts, users] = await Promise.all([allArtifacts(), listUsers()]);
  const roleById = new Map<string, Role>(users.map((u) => [u.id, u.role]));
  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return tallyAdoption(arts, roleById, { windowDays: ACTIVE_WINDOW_DAYS, cutoff, domainFilter, viewerId });
}

/**
 * Resolve the live actuals a pillar's targets are tracked against, scoped to the
 * pillar's domain (tenant pillar → tenant roll-up). Returns certified + promoted
 * counts per kind plus active people — the numbers the monthly snapshot captures.
 */
export async function adoptionActuals(scope: 'tenant' | string): Promise<{
  certified: Record<ArtifactKind, number>;
  promoted: Record<ArtifactKind, number>;
  activeCreators: number;
  activeBuilders: number;
}> {
  const board = await adoptionBoard(scope === 'tenant' ? undefined : scope);
  const src = scope === 'tenant' ? board.tenant : board.domains.find((d) => d.domain === scope);
  const certified = {} as Record<ArtifactKind, number>;
  const promoted = {} as Record<ArtifactKind, number>;
  for (const k of ARTIFACT_KINDS) {
    certified[k] = src ? src.counts[k].certified : 0;
    promoted[k] = src ? src.counts[k].promoted : 0;
  }
  return {
    certified,
    promoted,
    activeCreators: src?.activeCreators ?? 0,
    activeBuilders: src?.activeBuilders ?? 0,
  };
}
