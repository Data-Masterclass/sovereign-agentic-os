/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { FileAsset } from './asset-schema.ts';

/**
 * The Files DLS compiler (data-policy-compiler.md, applied to OpenSearch
 * document-level security). It turns a reader's DELEGATED IDENTITY (id + domains)
 * plus each file's tier / visibility / grants into ONE OpenSearch bool filter — the
 * single policy source, compiled once and **enforced everywhere**:
 *
 *   • LIVE — the filter is AND-ed into every `files` index `_search` (Phase 5), so
 *     OpenSearch only ever returns documents the user may see.
 *   • KIND — the exact same filter object is evaluated in-process by `evaluateDls`
 *     over each asset's metadata, so the mock store enforces the identical policy.
 *
 * This is why a non-member is "denied by the DLS filter" rather than by ad-hoc UI
 * logic: there is one compiled rule. Row/column masking (the richer grant scope)
 * rides on the same `grants` source and is layered in with the live index.
 *
 * Pure module — no server/network imports — so the store, the routes, the live
 * retrieval tool and the tests share it.
 */

/** The delegated reader — exactly the low-cardinality identity OpenSearch DLS sees. */
export type Reader = { id: string; domains: string[] };

/** The subset of a file's metadata the DLS filter matches on (lives in the index). */
export type DocMeta = {
  owner: string;
  tier: FileAsset['tier'];
  domain: string;
  /** User ids named in cross-domain individual grants. */
  grantedUsers: string[];
};

// --- A minimal, real subset of the OpenSearch query DSL we both emit and evaluate -

export type Term = { term: Record<string, string> };
export type Terms = { terms: Record<string, string[]> };
export type Bool = { bool: { filter?: Clause[]; should?: Clause[]; must?: Clause[]; minimum_should_match?: number } };
export type Clause = Term | Terms | Bool;

/** The compiled DLS filter for one reader (an OpenSearch bool/should). */
export type DlsFilter = { bool: { should: Clause[]; minimum_should_match: 1 } };

/**
 * Compile the reader's identity into the bool/should filter. A document is visible
 * if ANY clause matches:
 *   1. it is the reader's own file               (owner == reader)
 *   2. it is a marketplace product               (tier == product)
 *   3. it is a domain asset in one of their domains
 *   4. it is an asset with a named-individual grant to them
 */
export function compileDls(reader: Reader): DlsFilter {
  const should: Clause[] = [
    { term: { owner: reader.id } },
    { term: { tier: 'product' } },
    { bool: { filter: [{ term: { tier: 'asset' } }, { terms: { domain: reader.domains } }] } },
    { bool: { filter: [{ term: { tier: 'asset' } }, { term: { grantedUsers: reader.id } }] } },
  ];
  return { bool: { should, minimum_should_match: 1 } };
}

/** Project an asset down to the indexed metadata the DLS filter matches on. */
export function docMetaOf(a: FileAsset): DocMeta {
  return {
    owner: a.owner,
    tier: a.tier,
    domain: a.domain,
    grantedUsers: a.grants.filter((g) => g.grantee.kind === 'user').map((g) => g.grantee.id),
  };
}

// --- The in-process evaluator: the SAME filter OpenSearch would apply, in JS ------

function fieldValues(doc: DocMeta, field: string): string[] {
  switch (field) {
    case 'owner': return [doc.owner];
    case 'tier': return [doc.tier];
    case 'domain': return [doc.domain];
    case 'grantedUsers': return doc.grantedUsers;
    default: return [];
  }
}

function matchClause(clause: Clause, doc: DocMeta): boolean {
  if ('term' in clause) {
    const [field, value] = Object.entries(clause.term)[0];
    return fieldValues(doc, field).includes(value);
  }
  if ('terms' in clause) {
    const [field, values] = Object.entries(clause.terms)[0];
    const have = fieldValues(doc, field);
    return values.some((v) => have.includes(v));
  }
  // bool
  const b = clause.bool;
  if (b.filter && !b.filter.every((c) => matchClause(c, doc))) return false;
  if (b.must && !b.must.every((c) => matchClause(c, doc))) return false;
  if (b.should) {
    const min = b.minimum_should_match ?? 1;
    const matched = b.should.filter((c) => matchClause(c, doc)).length;
    if (matched < min) return false;
  }
  return true;
}

/** Evaluate a compiled DLS filter against one document's metadata (mock enforcement). */
export function evaluateDls(filter: DlsFilter, doc: DocMeta): boolean {
  return matchClause(filter, doc);
}

/** Convenience: may this reader see this file? (compile → project → evaluate). */
export function canRead(a: FileAsset, reader: Reader): boolean {
  return evaluateDls(compileDls(reader), docMetaOf(a));
}
