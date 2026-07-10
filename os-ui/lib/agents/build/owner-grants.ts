/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { getPublicUser } from '@/lib/platform-admin/users';
import type { Role } from '@/lib/core/session';
import { parseSystem, serializeSystem, downgradeGrantsForRole, type System } from '../system-schema.ts';

/**
 * Read the OWNER's effective role LIVE (never trusted from the token that saved
 * the yaml). Fail-safe to LEAST privilege (`creator`) when the owner is missing
 * OR disabled — a disabled builder-owner must not keep direct-write rights (the
 * scheduled OS-team path already refuses disabled owners; this keeps build / run /
 * probe consistent).
 */
export async function ownerRoleLive(ownerId: string): Promise<Role> {
  const u = await getPublicUser(ownerId);
  return u && !u.disabled ? u.role : 'creator';
}

/**
 * Runtime re-assertion of the builder-gate against the OWNER's CURRENT role (S1):
 * the SAVE-time check runs only once, so a `Write-bounded` (direct-write) grant
 * set while the owner was a builder would otherwise survive a later downgrade —
 * and scheduled runs execute under the owner's delegated identity. Before a system
 * is BUILT / RUN / PROBED, every stale direct-write grant is downgraded to
 * `Write-approval` (held for a human) when the owner is no longer builder+. Fails
 * to approval, never to error — the agent keeps working.
 */
export async function governSystemForOwner(sys: System, ownerId: string): Promise<System> {
  return downgradeGrantsForRole(sys, await ownerRoleLive(ownerId));
}

/** {@link governSystemForOwner} for callers that thread the yaml text (build/run). */
export async function governYamlForOwner(yaml: string, ownerId: string): Promise<string> {
  return serializeSystem(await governSystemForOwner(parseSystem(yaml), ownerId));
}
