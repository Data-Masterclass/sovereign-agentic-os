/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { listMarketplace, getArtifact, addFromMarketplace, createArtifact } from '@/lib/core/artifacts';
import { createConnection, templateByKey, type ConnectionTemplateKey } from '@/lib/connections';
import { enqueue } from '@/lib/governance/approvals';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import type { Artifact } from '@/lib/core/artifact-model';

import type {
  Listing,
  ListingDetail,
  ListingFilter,
  ListingAdapter,
  PublishAdapter,
  ImportAdapter,
  ImportResult,
  DeprecateResult,
  Grant,
  Viewer,
  ImportMode,
  ProductType,
  AdapterSource,
  TrustSignals,
} from './types';
import { actingDomain } from './types';
import {
  importModesFor,
  isModeAllowed,
  enforcementTarget,
  defaultAccessPolicy,
  importNote,
} from './import-policy';
import { compileRls, applyRls } from './rls';
import { planDeprecation, importerLineage } from './lineage';
import {
  mockCatalog,
  mockProduct,
  basePreview,
  type MockProduct,
  putGrant,
  newGrantId,
  allGrants,
  grantsForListing,
  grantsForUser,
  findGrant,
  recordAudit,
  rate as storeRate,
  ratingFor,
  isDeprecated,
  setDeprecated,
} from './store';

/**
 * The three marketplace adapters (listing/discovery · publish · per-type import)
 * over a single composite source: the offline-mock certified catalog (store.ts)
 * UNION the real certified artifacts (lib/artifacts.ts). Both back the same
 * `Listing` shape; the live OpenMetadata `/data-marketplace` + OpenSearch path
 * augments the registry when reachable, else the mock is authoritative — the
 * dual pattern the whole OS UI uses.
 *
 * Import is the spine: per-type it compiles a governed grant (RLS via the policy
 * compiler), routes approval-required imports to the Governance queue, and for
 * fork/instance/template types derives a new owned artifact instead.
 */

// --------------------------------------------------------------- live probe --

let liveProbe: { at: number; live: boolean } = { at: 0, live: false };

async function probeLive(): Promise<boolean> {
  const fresh = Date.now() - liveProbe.at < 10_000;
  if (fresh) return liveProbe.live;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  let live = false;
  try {
    const res = await fetch(`${config.opensearchUrl}`, { signal: ctrl.signal, cache: 'no-store' });
    live = !!res && res.ok;
  } catch {
    live = false;
  } finally {
    clearTimeout(timer);
  }
  liveProbe = { at: Date.now(), live };
  return live;
}

// ------------------------------------------------------------- listing build --

function trustFor(listingId: string, base: { quality: number; freshness: number }): TrustSignals {
  const grants = grantsForListing(listingId).filter((g) => g.status !== 'revoked');
  const domains = new Set(grants.map((g) => g.granteeDomain));
  const { rating, ratingCount } = ratingFor(listingId);
  return {
    certified: true,
    freshness: base.freshness,
    quality: base.quality,
    imports: domains.size,
    rating,
    ratingCount,
  };
}

function listingFromMock(p: MockProduct): Listing {
  const { default: defaultMode, options } = importModesFor(p.type);
  return {
    id: p.id,
    productId: p.id,
    type: p.type,
    name: p.name,
    description: p.description,
    owner: p.owner,
    ownerDomain: p.ownerDomain,
    tags: p.tags,
    status: isDeprecated(p.id) ? 'deprecated' : 'listed',
    accessPolicy: p.accessPolicyOverride ?? defaultAccessPolicy(p.type, defaultMode),
    defaultMode,
    modeOptions: options,
    trust: trustFor(p.id, p),
    updatedAt: new Date().toISOString(),
    registry: p.registry,
  };
}

/** Map a real certified artifact (lib/artifacts.ts) into a Listing. */
function listingFromArtifact(a: Artifact): Listing {
  const type = a.type as ProductType;
  const { default: defaultMode, options } = importModesFor(type);
  const id = `art_${a.id}`;
  return {
    id,
    productId: a.id,
    type,
    name: a.name,
    description: a.description,
    owner: a.owner,
    ownerDomain: a.domain,
    tags: a.tags,
    status: isDeprecated(id) ? 'deprecated' : 'listed',
    accessPolicy: defaultAccessPolicy(type, defaultMode),
    defaultMode,
    modeOptions: options,
    trust: trustFor(id, { quality: 0.85, freshness: 0.8 }),
    updatedAt: a.updatedAt,
    registry: type === 'metric' || type === 'dataset' ? 'openmetadata' : 'os-registry',
  };
}

async function allListings(): Promise<Listing[]> {
  const mock = mockCatalog().map(listingFromMock);
  let real: Listing[] = [];
  try {
    const arts = await listMarketplace();
    // Avoid duplicating worked-example fixtures that exist in both sources.
    const mockNames = new Set(mock.map((m) => `${m.type}:${m.name.toLowerCase()}`));
    real = arts
      .filter((a) => !mockNames.has(`${a.type}:${a.name.toLowerCase()}`))
      .map(listingFromArtifact);
  } catch {
    real = [];
  }
  return [...mock, ...real];
}

function matchesFilter(l: Listing, f: ListingFilter): boolean {
  if (!f.includeDeprecated && l.status === 'deprecated') return false;
  if (f.type && l.type !== f.type) return false;
  if (f.domain && l.ownerDomain !== f.domain) return false;
  if (f.tag && !l.tags.includes(f.tag)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = `${l.name} ${l.description} ${l.tags.join(' ')}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// ------------------------------------------------------------ ListingAdapter --

class CompositeListingAdapter implements ListingAdapter {
  private lastSource: AdapterSource = 'offline-mock';

  async list(filter: ListingFilter): Promise<Listing[]> {
    this.lastSource = (await probeLive()) ? 'live' : 'offline-mock';
    const all = await allListings();
    return all
      .filter((l) => matchesFilter(l, filter))
      .sort((a, b) => b.trust.imports - a.trust.imports || a.name.localeCompare(b.name));
  }

  async get(listingId: string, viewer: Viewer): Promise<ListingDetail | null> {
    this.lastSource = (await probeLive()) ? 'live' : 'offline-mock';
    const all = await allListings();
    const listing = all.find((l) => l.id === listingId);
    if (!listing) return null;

    // Preview, RLS-filtered for the requesting viewer (the "different rows" proof).
    const mp = mockProduct(listing.productId);
    const viewerDomain = actingDomain(viewer);
    let preview = mp ? basePreview(mp) : await artifactPreview(listing.productId);
    if (preview.kind === 'rows' && preview.columns && preview.rows) {
      const scope = compileRls(viewerDomain);
      const filtered = applyRls(scope, preview.columns, preview.rows);
      preview = { ...preview, columns: filtered.columns, rows: filtered.rows, rlsApplied: scope.rows };
    }

    // Lineage: upstream (from the product) + importers (derived from grants).
    const upstream = mp?.upstream ?? [];
    const lineage = [...upstream, ...importerLineage(grantsForListing(listingId), listingId)];

    // Owner-visible usage roll-up.
    const importers = grantsForListing(listingId)
      .filter((g) => g.status !== 'revoked')
      .map((g) => ({ domain: g.granteeDomain, user: g.granteeUser, mode: g.mode, status: g.status, at: g.createdAt }));

    return { ...listing, preview, lineage, importers };
  }

  source(): AdapterSource {
    return this.lastSource;
  }
}

async function artifactPreview(productId: string): Promise<ListingDetail['preview']> {
  const a = await getArtifact(productId);
  if (!a) return { kind: 'text', text: 'No preview available.' };
  return { kind: 'spec', text: JSON.stringify(a.spec ?? {}, null, 2) };
}

// ------------------------------------------------------------ PublishAdapter --

class RegistryPublishAdapter implements PublishAdapter {
  async certify(productId: string, actor: Viewer): Promise<Listing> {
    if (actor.role !== 'admin') throw withStatus(new Error('Certifying to the Marketplace requires an admin'), 403);
    // A real artifact is certified in its own tab (artifacts.promoteArtifact);
    // here we surface the resulting listing. Mock fixtures are already certified.
    const mp = mockProduct(productId);
    if (mp) {
      const listing = listingFromMock(mp);
      recordAudit({ actor: actor.id, action: 'certify', listingId: listing.id, detail: `Certified ${mp.name}`, domain: mp.ownerDomain });
      return listing;
    }
    const a = await getArtifact(productId);
    if (!a) throw withStatus(new Error('Product not found'), 404);
    const listing = listingFromArtifact(a);
    recordAudit({ actor: actor.id, action: 'certify', listingId: listing.id, detail: `Certified ${a.name}`, domain: a.domain });
    return listing;
  }

  async deprecate(listingId: string, actor: Viewer): Promise<DeprecateResult> {
    if (actor.role !== 'admin') throw withStatus(new Error('Deprecating requires an admin'), 403);
    const all = await allListings();
    const listing = all.find((l) => l.id === listingId);
    if (!listing) throw withStatus(new Error('Listing not found'), 404);
    if (!actor.domains.includes(listing.ownerDomain)) {
      throw withStatus(new Error('You can only deprecate listings your domain owns'), 403);
    }
    const result = planDeprecation(listingId, grantsForListing(listingId));
    setDeprecated(listingId); // grants stay active — never silently removed
    recordAudit({
      actor: actor.id,
      action: 'deprecate',
      listingId,
      detail: result.warned.length ? `Deprecated; warned importers: ${result.warned.join(', ')}` : 'Deprecated (no importers)',
      domain: listing.ownerDomain,
    });
    return result;
  }
}

// ------------------------------------------------------------- ImportAdapter --

class GovernedImportAdapter implements ImportAdapter {
  async import(listingId: string, viewer: Viewer, requestedMode?: ImportMode): Promise<ImportResult> {
    // Security: only a Builder+ may import a product into their domain (it grants
    // the whole domain access). A participant/creator is blocked (403) and must
    // route the import through a domain Builder/Admin — the API's real control.
    if (!roleAtLeast(viewer.role, 'builder')) {
      throw withStatus(new Error('Importing from the Marketplace requires a Builder or Admin — ask a domain Builder to import it'), 403);
    }
    const all = await allListings();
    const listing = all.find((l) => l.id === listingId);
    if (!listing) throw withStatus(new Error('Listing not found'), 404);

    const mode = requestedMode ?? listing.defaultMode;
    if (!isModeAllowed(listing.type, mode)) {
      throw withStatus(new Error(`A ${listing.type} cannot be imported as ${mode}`), 400);
    }

    const granteeDomain = actingDomain(viewer);
    // You don't import from your own domain — it's already yours.
    if (granteeDomain === listing.ownerDomain) {
      throw withStatus(new Error('This product already belongs to your domain'), 400);
    }

    // Idempotent: return the existing grant if already imported this way.
    const existing = findGrant(listingId, viewer.id, mode);
    if (existing) return { grant: existing, pending: existing.status === 'pending', note: importNote(listing.type, mode) };

    // Compile the governed grant (the policy-compiler output for this import).
    const enforcedBy = enforcementTarget(listing.type, mode);
    const scope = mode === 'read-grant' ? compileRls(granteeDomain) : { rows: 'true' };
    const accessPolicy = listing.accessPolicy; // owner-set, default per (type, mode)

    const now = new Date().toISOString();
    const grant: Grant = {
      id: newGrantId(),
      listingId,
      productId: listing.productId,
      type: listing.type,
      productName: listing.name,
      mode,
      granteeUser: viewer.id,
      granteeDomain,
      ownerUser: listing.owner,
      ownerDomain: listing.ownerDomain,
      scope,
      enforcedBy,
      status: accessPolicy === 'approval' ? 'pending' : 'active',
      createdAt: now,
      updatedAt: now,
    };

    // Materialize fork/instance/template side-effects when auto-granted.
    if (grant.status === 'active') {
      grant.derivedId = await materialize(listing.productId, listing.type, mode, viewer);
    }

    // Approval-required imports surface in the Governance inbox.
    if (accessPolicy === 'approval') {
      const approval = enqueue({
        kind: 'marketplace_import',
        title: `Import “${listing.name}” into ${granteeDomain}`,
        detail: `${viewer.id} requests a ${mode} import of the ${listing.type} “${listing.name}” (owned by ${listing.ownerDomain}).`,
        agent: 'marketplace',
        domain: listing.ownerDomain, // the OWNER's domain approves access to their product
        requestedBy: viewer.id,
        tool: `marketplace.import:${mode}`,
        payload: { listingId, productId: listing.productId, mode, granteeDomain },
      });
      grant.approvalId = approval.id;
    }

    putGrant(grant);
    recordAudit({
      actor: viewer.id,
      action: grant.status === 'pending' ? 'import_requested' : 'import',
      listingId,
      detail: `${mode} import of ${listing.name} → ${granteeDomain} (${enforcedBy}${grant.status === 'pending' ? ', pending approval' : ''})`,
      domain: granteeDomain,
    });

    return { grant, pending: grant.status === 'pending', note: importNote(listing.type, mode) };
  }
}

/**
 * Apply the non-grant side of a fork / template / deploy-instance import. Every
 * mode now materialises a REAL object the importer owns and can see in its tab:
 *   • fork            → an owned artifact copy (registry copy-to-own, else a fresh copy).
 *   • template        → a real BYO-credentials Connection in the Connections tab.
 *   • deploy-instance → a real owned artifact recording the instance + its HONEST
 *                       deploy status (a true in-cluster Argo roll-out still needs
 *                       the platform deploy pipeline, so the record is marked
 *                       pending — never a fake "deployed").
 */
async function materialize(
  productId: string,
  type: ProductType,
  mode: ImportMode,
  viewer: Viewer,
): Promise<string | undefined> {
  if (mode === 'fork') return materializeFork(productId, type, viewer);
  if (mode === 'template') return materializeTemplate(productId, viewer);
  if (mode === 'deploy-instance') return materializeInstance(productId, viewer);
  return undefined;
}

function viewerAsUser(viewer: Viewer): CurrentUser {
  return { id: viewer.id, name: viewer.id, domains: viewer.domains, allDomains: viewer.domains, activeDomain: null, role: viewer.role };
}

/** Name / tags / spec of a product, from the mock catalog or the real artifact registry. */
async function productMeta(productId: string): Promise<{ name: string; tags: string[]; spec: Record<string, unknown> }> {
  const mp = mockProduct(productId);
  if (mp) return { name: mp.name, tags: mp.tags, spec: mp.previewSpec ?? {} };
  const a = await getArtifact(productId);
  if (a) return { name: a.name, tags: a.tags, spec: (a.spec ?? {}) as Record<string, unknown> };
  return { name: productId, tags: [], spec: {} };
}

/** fork: reuse the registry copy-to-own; fall back to a fresh owned copy for a mock fixture. */
async function materializeFork(productId: string, type: ProductType, viewer: Viewer): Promise<string | undefined> {
  const user = viewerAsUser(viewer);
  try {
    const copy = await addFromMarketplace(productId, user); // real certified artifact
    return copy.id;
  } catch {
    const meta = await productMeta(productId);
    const created = await createArtifact(user, {
      type: (type === 'app' ? 'agent' : type) as Artifact['type'],
      name: `${meta.name} (fork)`,
      description: `Forked from the certified ${type} “${meta.name}”.`,
      tags: [...meta.tags, 'fork'],
      spec: meta.spec,
      domain: actingDomain(viewer),
    });
    return created.id;
  }
}

/** Pick the connection template this product should instantiate (spec hint, else a generic API). */
function resolveTemplateKey(meta: { spec: Record<string, unknown> }): ConnectionTemplateKey {
  const hint = String(meta.spec.template ?? meta.spec.templateKey ?? meta.spec.connector ?? '').toLowerCase();
  if (templateByKey(hint)) return hint as ConnectionTemplateKey;
  return 'generic-api';
}

/**
 * template: create a REAL BYO-credentials Connection owned by the importer. It lands
 * in their Connections tab (Personal, no secret yet) for them to add credentials —
 * the actual create side of `lib/connections.ts`. Returns the new connection's id.
 */
async function materializeTemplate(productId: string, viewer: Viewer): Promise<string | undefined> {
  const meta = await productMeta(productId);
  try {
    const conn = await createConnection(viewerAsUser(viewer), {
      name: `${meta.name} (from template)`,
      template: resolveTemplateKey(meta),
      endpoint: '', // use the template's endpoint hint (egress-safe); the importer edits it in Connections
      credential: '', // BYO — the importer adds their own credential in the Connections tab
      domain: actingDomain(viewer),
    });
    return conn.id;
  } catch {
    return undefined; // never fail the whole import if the connection can't be created
  }
}

/**
 * deploy-instance: materialise a REAL owned artifact for the importer. A real certified
 * artifact is taken as an owned copy (the same path fork uses); an app from the Software
 * registry has no artifact row, so we create one that records the instance and its HONEST
 * deploy status. Provisioning a true in-cluster instance still needs the platform's Argo
 * deploy pipeline, so it is marked pending — not a fake "deployed".
 */
async function materializeInstance(productId: string, viewer: Viewer): Promise<string | undefined> {
  const user = viewerAsUser(viewer);
  try {
    const copy = await addFromMarketplace(productId, user); // real certified artifact → owned copy
    return copy.id;
  } catch {
    const meta = await productMeta(productId);
    const created = await createArtifact(user, {
      type: 'agent', // no 'app' ArtifactType — the instance is tracked as an owned artifact
      name: `${meta.name} (instance)`,
      description: `Your deployed instance of the certified app “${meta.name}”. Provisioning is pending the in-cluster deploy.`,
      tags: [...meta.tags, 'app-instance'],
      spec: { ...meta.spec, kind: 'app-instance', sourceProductId: productId, deployStatus: 'pending-provision', provisioned: false },
      domain: actingDomain(viewer),
    });
    return created.id;
  }
}

// ----------------------------------------------------------------- exports --

export const listingAdapter = new CompositeListingAdapter();
export const publishAdapter = new RegistryPublishAdapter();
export const importAdapter = new GovernedImportAdapter();

/** Rate a listing (1..5). Returns the new aggregate. */
export function rateListing(listingId: string, viewer: Viewer, stars: number): { rating: number; ratingCount: number } {
  storeRate(listingId, viewer.id, stars);
  recordAudit({ actor: viewer.id, action: 'rate', listingId, detail: `Rated ${stars}★`, domain: actingDomain(viewer) });
  return ratingFor(listingId);
}

/** A consumer's imports (their grants) for the "My imports" view. */
export function myImports(viewer: Viewer): Grant[] {
  return grantsForUser(viewer.id);
}

/**
 * Reconcile a pending marketplace grant once its Governance approval is cleared.
 * Called from the approvals API after `decide()`. Approving flips the grant to
 * active (and materializes fork/template/instance side-effects); rejecting
 * revokes it. Either way the decision is audited.
 */
export async function onApprovalDecided(
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<Grant | null> {
  const found = allGrants().find((g) => g.approvalId === approvalId && g.status === 'pending');
  if (!found) return null;
  if (decision === 'approve') {
    found.status = 'active';
    found.derivedId = await materialize(found.productId, found.type, found.mode, {
      id: found.granteeUser,
      domains: [found.granteeDomain],
      role: 'builder',
      activeDomain: found.granteeDomain,
    });
    found.updatedAt = new Date().toISOString();
    putGrant(found);
    recordAudit({ actor: 'governance', action: 'import', listingId: found.listingId, detail: `Approved import of ${found.productName} → ${found.granteeDomain}`, domain: found.granteeDomain });
  } else {
    found.status = 'revoked';
    found.updatedAt = new Date().toISOString();
    putGrant(found);
    recordAudit({ actor: 'governance', action: 'revoke', listingId: found.listingId, detail: `Rejected import of ${found.productName} → ${found.granteeDomain}`, domain: found.granteeDomain });
  }
  return found;
}

function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}
