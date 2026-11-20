/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import { getDataset, builtLayerFqn } from '@tabs/data/lib/store';
import type { Layer } from '@tabs/data/lib/index';
import { LAYERS } from '@tabs/data/lib/index';

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
  /** `not_built` when a governed dataset has no readable table for the request. */
  code?: string;
  requestedLayer: Layer;
  layer?: Layer;
  fqn?: string;
  built: Layer[];
  note: string | null;
} {
  const requestedLayer: Layer = requested && LAYERS.includes(requested) ? requested : 'gold';
  const built = LAYERS.filter((l) => d.versions[l].built);
  // A governed dataset answers only the layer asked for (an explicit layer is never swapped for
  // another), so it gets the caller's EXPLICIT choice; a personal one keeps the gold default.
  const explicit = requested && LAYERS.includes(requested) ? requested : undefined;
  const resolved = builtLayerFqn(d, P(user), d.tier !== 'dataset' ? explicit : requestedLayer);
  if (!resolved) {
    if (d.tier !== 'dataset') {
      // A governed dataset: the asked-for layer is not served (and not readable from a lane that
      // is provably its own) — a typed not_built, never another layer in its place.
      return {
        available: false,
        code: 'not_built',
        requestedLayer,
        built,
        note: `“${d.name}” (${d.id}) has no ${explicit ?? 'served'} layer to read: only its published domain copy is served${explicit ? ', and its owner\u2019s lane cannot be shown as this dataset' : ''}.`,
      };
    }
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
