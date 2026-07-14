/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PURE create-flow glue (Phase 1b integration).
 *
 * The create UI collects one flat `{ fieldKey: value }` map from the provider's
 * `credentialFields`. This module splits that map, deterministically, into:
 *   - `config`  — the NON-SECRET fields that live on the Connection record, and
 *   - `secrets` — the SECRET fields (keys in `provider.secretMaterial.secretKeys`)
 *                 that the store writes to Secrets Manager and NEVER onto the record.
 *
 * It also builds the typed {@link WarehouseSource} the pure catalog-props generator
 * consumes. Everything here is pure: no I/O, no secrets emitted anywhere but the
 * returned `secrets` map (which the caller hands straight to `putSecret`).
 *
 * The split is driven ENTIRELY by the provider metadata, so adding a platform never
 * touches this file — the one-object-per-file discipline holds through the seam.
 */

import {
  type WarehouseSource,
  type WarehousePlatform,
  isValidCatalogName,
  WarehouseError,
} from './types.ts';
import { providerFor } from './registry.ts';

/** A credential field whose value belongs in Secrets Manager, not on the record. */
function isSecretField(platform: WarehousePlatform, key: string): boolean {
  return providerFor(platform).secretMaterial.secretKeys.includes(key);
}

/**
 * Split a flat field map (from the provider's `credentialFields`) into the record's
 * non-secret `config` and the vault-bound `secrets`. Validates required fields and
 * the catalog name. Pure + total: throws `WarehouseError` on a missing required
 * field, an unknown field, or a bad catalog name — never silently drops input.
 */
export function splitWarehouseFields(input: {
  platform: WarehousePlatform;
  catalog: string;
  fields: Record<string, string>;
}): { config: Record<string, string>; secrets: Record<string, string> } {
  const provider = providerFor(input.platform);
  const catalog = (input.catalog ?? '').trim();
  if (!isValidCatalogName(catalog)) {
    throw new WarehouseError(
      `invalid Trino catalog name '${catalog}' (must match [a-z_][a-z0-9_]*)`,
    );
  }

  const known = new Set(provider.credentialFields.map((f) => f.key));
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const field of provider.credentialFields) {
    const raw = input.fields[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (field.required && !value) {
      throw new WarehouseError(`${input.platform}: missing required field '${field.key}' (${field.label})`);
    }
    if (!value) continue; // optional + blank → omit entirely
    if (isSecretField(input.platform, field.key)) {
      secrets[field.key] = value; // → Secrets Manager only, never the record
    } else {
      config[field.key] = value;
    }
  }

  // Reject stray keys so a typo in the UI never lands unvalidated on the record.
  for (const key of Object.keys(input.fields)) {
    if (!known.has(key)) {
      throw new WarehouseError(`${input.platform}: unknown field '${key}'`);
    }
  }

  return { config, secrets };
}

/**
 * Assemble the typed {@link WarehouseSource} that the pure catalog-props generator
 * consumes, from the stored non-secret `config` (the record's `warehouse.config`).
 * Secret values are DELIBERATELY absent — the props generator references them via
 * `${ENV:...}` and never sees the material. Pure + total.
 */
export function toWarehouseSource(input: {
  platform: WarehousePlatform;
  catalog: string;
  config: Record<string, string>;
}): WarehouseSource {
  if (!isValidCatalogName(input.catalog)) {
    throw new WarehouseError(
      `invalid Trino catalog name '${input.catalog}' (must match [a-z_][a-z0-9_]*)`,
    );
  }
  // The config is the platform block minus secrets; the union is discriminated by
  // `platform`, so spread the collected non-secret fields onto it. The props
  // generator re-validates every field it needs (region, database, projectId …).
  return {
    catalog: input.catalog,
    platform: input.platform,
    ...input.config,
  } as WarehouseSource;
}
