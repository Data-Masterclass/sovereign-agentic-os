/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { AppSpec } from '@/lib/software/appspec/schema';

/**
 * GUARDED, IDEMPOTENT server seed — stands up ONE live declarative demo app so the OS
 * ships a clickable example of the AppSpec model (a governed view over the real Northpeak
 * Products dataset) with ZERO manual authoring. It is DECLARATIVE (`kind:'spec'`): no repo,
 * no CI, no pod — the OS renders it same-origin at `/apps/<slug>` (see appspec/DESIGN.md).
 *
 * FAIL-SOFT + ADDITIVE: every step is wrapped so a slip (store unavailable, a transient
 * throw) logs one honest line and returns — it must NEVER break boot or any environment.
 * The guards below hold ONLY on the real deploy where the Northpeak seed exists, so on a
 * fresh/CI/laptop env this is a silent, cheap no-op.
 */

/** The Northpeak Products dataset (real production id) this demo app views. */
const DATASET_ID = 'ds_zpco1s6n7y';
/** The owner the demo app is created AS (the Northpeak dataset owner). */
const OWNER = 'aborek';
/** The domain the demo app lives in (where the Northpeak seed lives). */
const DOMAIN = 'agentic-leader-q3-2026';
/** The app name + its derived slug (the slug is what `/apps/<slug>` serves). */
const APP_NAME = 'Northpeak Product Catalog (Demo)';
const APP_SLUG = 'northpeak-product-catalog-demo';
const APP_DESCRIPTION =
  'A declarative example app — a governed view over the Northpeak Products dataset, built ' +
  'with AppSpec patterns (no code, no container).';

/**
 * The demo SPEC (v2 — 3 tabs, all VIEW patterns that already render). Every `field` below is
 * a REAL column of the Northpeak Products dataset (product_id, product_name, category, brand,
 * list_price_eur), so `validateAppSpec` accepts it cleanly. Field names match `patterns.ts`
 * exactly: records-table `sort` is a bare column string; status-board uses `subtitleFields`.
 */
const SPEC: AppSpec = {
  version: 2,
  name: APP_NAME,
  description: 'Declarative example over the governed Northpeak Products dataset.',
  tabs: [
    {
      id: 'products',
      label: 'Products',
      body: {
        kind: 'pattern',
        pattern: 'records-table',
        config: {
          source: { datasetId: DATASET_ID },
          columns: [
            { field: 'product_name', label: 'Product' },
            { field: 'category', label: 'Category', format: 'badge' },
            { field: 'brand', label: 'Brand' },
            { field: 'list_price_eur', label: 'List price', format: 'currency-eur' },
          ],
          search: true,
          filters: [
            { field: 'category', control: 'select' },
            { field: 'brand', control: 'select' },
          ],
          sort: 'list_price_eur',
          pageSize: 25,
        },
      },
    },
    {
      id: 'detail',
      label: 'Product Detail',
      body: {
        kind: 'pattern',
        pattern: 'detail',
        config: {
          source: { datasetId: DATASET_ID },
          keyField: 'product_id',
          fields: [
            { field: 'product_name', label: 'Product' },
            { field: 'category', label: 'Category' },
            { field: 'brand', label: 'Brand' },
            { field: 'list_price_eur', label: 'List price', format: 'currency-eur' },
          ],
        },
      },
    },
    {
      id: 'by-brand',
      label: 'By Brand',
      body: {
        kind: 'pattern',
        pattern: 'status-board',
        config: {
          source: { datasetId: DATASET_ID },
          statusField: 'brand',
          titleField: 'product_name',
          subtitleFields: ['category'],
        },
      },
    },
  ],
};

/** The CurrentUser the seed acts AS — `aborek`, scoped to the demo domain, at builder
 *  (needs the setAppSpec write door). A server-initiated identity, never a login. */
function seedUser(): CurrentUser {
  return {
    id: OWNER,
    name: OWNER,
    domains: [DOMAIN],
    allDomains: [DOMAIN],
    activeDomain: DOMAIN,
    role: 'builder',
  };
}

const LOG = '[os-ui] declarative demo-app seed';

/**
 * Stand up the Northpeak Product Catalog demo app IF (and only if) all guards hold:
 *   1. the domain `agentic-leader-q3-2026` context is present (the dataset lives there),
 *   2. the dataset `ds_zpco1s6n7y` EXISTS and is READABLE by owner `aborek`,
 *   3. no app with the demo slug already exists (idempotent — a second call no-ops).
 * When they hold: create the app as `aborek` (kind:'spec'), grant the dataset read, then
 * setAppSpec. If setAppSpec returns blocking issues, log them and clean up the half-built
 * app. Every failure is swallowed with one honest line — this NEVER throws.
 */
export async function seedDeclarativeDemoApp(): Promise<void> {
  try {
    // Lazy imports keep this module (and its data/apps store deps) off any edge/build path.
    const { peekDatasetMeta, getDataset, ensureHydrated: ensureDataHydrated } = await import('@/lib/data/store');
    const {
      createApp,
      getAppBySlugInternal,
      patchAppDesign,
      setAppSpec,
      removeAppInternal,
      ensureHydrated: ensureAppsHydrated,
    } = await import('@/lib/software/apps');

    // The seed runs at the instrumentation boot hook — BEFORE either store has hydrated
    // from the durable mirror, so a naive dataset peek sees an empty registry and skips.
    // Await both hydrations first: the dataset guard then sees the real registry, and the
    // app-existence check stays idempotent across restarts. Fail-soft — a down mirror
    // leaves them empty and GUARD 2a below simply skips (never a fabricated seed).
    await ensureDataHydrated();
    await ensureAppsHydrated();

    // GUARD 2a — the dataset must EXIST (peek is unscoped, non-throwing on absence).
    const meta = peekDatasetMeta(DATASET_ID);
    if (!meta) {
      console.info(`${LOG}: skip — dataset ${DATASET_ID} not present (fresh/CI env).`);
      return;
    }

    // GUARD 2b — it must be READABLE by owner `aborek` (getDataset throws if not permitted).
    // This also implicitly checks the dataset's domain wiring (GUARD 1) via the owner scope.
    try {
      getDataset(DATASET_ID, { id: OWNER, domains: [DOMAIN], role: 'builder' });
    } catch {
      console.info(`${LOG}: skip — dataset ${DATASET_ID} not readable by ${OWNER}.`);
      return;
    }

    // GUARD 3 — idempotency: no app with the demo slug may already exist.
    const existing = await getAppBySlugInternal(APP_SLUG);
    if (existing) {
      console.info(`${LOG}: skip — app "${APP_SLUG}" already exists (idempotent no-op).`);
      return;
    }

    const user = seedUser();

    // 1. Create the app AS aborek in the demo domain — declarative (no repo/CI/pod).
    const app = await createApp(user, {
      kind: 'spec',
      name: APP_NAME,
      description: APP_DESCRIPTION,
      domain: DOMAIN,
      surface: 'ui',
    });

    // 2. GRANT the Northpeak dataset (read) to the app — reuse the governed grant door
    //    (patchAppDesign persists app.grants + re-derives the OPA capability profile).
    const grants = { ...app.grants, data: [{ id: DATASET_ID, access: 'read-only' as const }] };
    await patchAppDesign(app.id, user, { grants });

    // 3. Set the validated spec — flips serveMode to 'spec' + serves it at /apps/<slug>.
    const { issues } = await setAppSpec(app.id, SPEC, user);
    if (issues.length > 0) {
      // The spec should validate (columns are the dataset's real schema); if it does not,
      // do NOT leave a half-built app — clean it up and report the exact issues.
      console.info(
        `${LOG}: spec rejected (${issues.length} issue${issues.length === 1 ? '' : 's'}), cleaning up — ` +
          issues.map((i) => `${i.path}: ${i.reason}`).join('; '),
      );
      await removeAppInternal(app.id);
      return;
    }

    console.info(`${LOG}: created "${APP_SLUG}" (served at /apps/${APP_SLUG}).`);
  } catch (err) {
    // Fail-soft: a seed slip must NEVER break boot or any environment.
    console.info(`${LOG}: skipped — ${err instanceof Error ? err.message : String(err)}`);
  }
}
