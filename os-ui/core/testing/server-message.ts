/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Test helpers for coded server messages (i18n wave 4)
 * USER STORY: As a maintainer converting a route I want one assertion that the English the route sends is exactly
 *             what the catalog renders for its code, and that every language has that code — so English never drifts
 *             and no language shows a blank.
 * ARCHITECTURE: Renders `server.<code>` through the on-disk catalogs (`core/testing/catalog-text.ts`, the ICU engine
 *   next-intl uses). Test code only.
 */
import assert from 'node:assert/strict';
import { CATALOG_LOCALES, catalogText, hasCatalogKey } from '@core/testing/catalog-text';
import { isServerCode, type ServerParams } from '@core/kernel/server-message';

/** `server.<code>` rendered in `locale` (default English). Throws when the key is missing. */
export function serverText(code: string, params?: ServerParams, locale = 'en'): string {
  return catalogText('server', { key: code, args: params }, locale);
}

/**
 * Assert a coded body (`{ error, code, params }`, or a `codedError`) renders to EXACTLY its English through the
 * catalog, and that every language has the code and formats it with these params.
 */
export function assertServerEnglish(body: { error?: string; message?: string; code?: string; params?: ServerParams }, field: 'error' | 'message' = 'error'): void {
  const english = field === 'message' ? body.message : body.error;
  assert.ok(isServerCode(body.code), `expected a dotted server code, got ${String(body.code)}`);
  assert.equal(serverText(body.code!, body.params), english, `server.${body.code} (en) must equal the English the server sends`);
  for (const l of CATALOG_LOCALES) {
    assert.ok(hasCatalogKey('server', body.code!, l), `messages/${l}/server.json lacks ${body.code}`);
    const text = serverText(body.code!, body.params, l);
    assert.ok(text.trim().length > 0, `server.${body.code} (${l}) renders empty`);
  }
}
