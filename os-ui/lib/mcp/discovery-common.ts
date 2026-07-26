/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { McpTool, JsonSchema } from './server';
import { getDataset, builtLayerFqn } from '@/lib/data/store';
import type { Layer } from '@/lib/data';
import { LAYERS } from '@/lib/data';

export type Principal = { id: string; domains: string[]; role: Role };
export const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });

export function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];

export const NO_ARGS: JsonSchema = { type: 'object', properties: {}, examples: [{}] };
export const idArg = (name: string, desc: string): JsonSchema => ({
  type: 'object',
  properties: { [name]: { type: 'string', description: desc } },
  required: [name],
  examples: [{ [name]: 'id_ab12cd' }],
});

/**
 * Resolve the physical FQN + medallion layer a granted dataset queries FOR the caller,
 * honouring the layer the agent's DATA grant selected (Gold is the serving default).
 *
 * Fail-graceful (never crash): {@link builtLayerFqn} resolves the requested layer when
 * it is built, otherwise the FURTHEST built layer — so a `silver` grant on a dataset
 * whose silver isn't built yet resolves to the best available and we FLAG the miss
 * (`requestedLayer` ≠ resolved `layer`, plus a note) rather than 404. When NOTHING is
 * built we surface {available:false} with an honest reason. Viewer-aware: the FQN's
 * schema and the read principal always agree (owner ⇒ personal lane, else domain).
 */
export function resolveQueryable(
  d: ReturnType<typeof getDataset>,
  user: CurrentUser,
  requested?: Layer,
): {
  available: boolean;
  requestedLayer: Layer;
  layer?: Layer;
  fqn?: string;
  built: Layer[];
  note: string | null;
} {
  const requestedLayer: Layer = requested && LAYERS.includes(requested) ? requested : 'gold';
  const built = LAYERS.filter((l) => d.versions[l].built);
  const resolved = builtLayerFqn(d, P(user), requestedLayer);
  if (!resolved) {
    return {
      available: false,
      requestedLayer,
      built,
      note: `The ${requestedLayer} layer isn't built for this dataset yet — nothing to query.`,
    };
  }
  const fellBack = resolved.layer !== requestedLayer;
  return {
    available: true,
    requestedLayer,
    layer: resolved.layer,
    fqn: resolved.fqn,
    built,
    note: fellBack
      ? `The ${requestedLayer} layer isn't built yet — resolved to the furthest built layer (${resolved.layer}) instead.`
      : null,
  };
}
