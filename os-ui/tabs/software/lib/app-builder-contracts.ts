/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the shared contracts every App Builder workstream codes against
 * USER STORY: As a workstream author I want one file that names the living-spec, proposal, release and naming
 *             contracts exactly, so parallel work on stories, builds, releases, databases and identity fits
 *             together without anyone editing anyone else's code.
 * ARCHITECTURE:
 *   - Types and constants (plan W0 item 1, docs/superpowers/plans/2026-11-26-app-builder.md), plus the three
 *     pure name functions of spec section 2b. No I/O, no server import: client and server import it alike, so
 *     the SHA-256 the names need is a small pure implementation (checked against node:crypto in the tests).
 *   - NAMES ARE KEYED ON DOMAIN AND SLUG, NEVER SLUG ALONE: a slug is unique only within its domain and
 *     `apps-dev`/`apps-prod`/Postgres are shared by every domain. Decision recorded in the plan (W0 notes): the
 *     8-hex hash of "<domain>/<slug>" is ALWAYS part of the name, not only when it is too long. Without it
 *     `app-a-b-c` is both (domain a, slug b-c) and (domain a-b, slug c), and app `x`'s preview `app-d-x-p1` is
 *     app `x-p1`'s Deployment. With a fixed-length hash before the optional part, every (domain, slug, part)
 *     decodes to one name.
 */

export type EpicId = `EP-${number}`;
export type StoryId = `US-${number}`;
export type CriterionId = `AC-${number}`;
export type CriterionRef = `${StoryId}/${CriterionId}`;
export type Criterion = { id: CriterionId; title: string; given: string[]; when: string[]; then: string[] };
export type StoryState = 'draft' | 'agreed';
export type StoryStatus = 'draft' | 'agreed' | 'built' | 'verified';
export type StoryLight = 'green' | 'partial' | 'untested';
export type StoryDoc = {
  id: StoryId;
  epic: EpicId;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  state: StoryState;
  criteria: Criterion[];
  notes: string;
  path: string;
};
export type EpicDoc = {
  id: EpicId;
  title: string;
  description: string;
  requirements: { technical: string; ux: string; governance: string };
  path: string;
};
export type LivingSpec = { sha: string; epics: EpicDoc[]; stories: StoryDoc[] };
export type SpecSource = 'ui' | 'chat' | 'mcp' | 'git' | 'migration';
export type SpecVersion = {
  sha: string;
  at: string;
  author: { id: string; name: string };
  source: SpecSource;
  proposalId?: string;
  diff: string;
};
export type SpecIssue = { path: string; line?: number; reason: string; fix: string };
export type SpecChange = { writes: { path: string; content: string }[]; deletes: string[]; summary: string };
export type Classification = 'refine-story' | 'refine-epic' | 'new-story' | 'new-epic' | 'code-change';
export type SpecProposal = {
  id: string;
  appId: string;
  classification: Classification;
  targetId?: StoryId | EpicId;
  rationale: string;
  confidence: number;
  alternatives: Classification[];
  change: SpecChange;
  source: SpecSource;
  posthoc: boolean;
  commitShas?: string[];
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  createdAt: string;
};
export type CriteriaResults = { v: 1; truncated?: true; results: Record<CriterionRef, { pass: number; fail: number }> };

/** Tekton result names the platform pipeline writes (spec section 5 and 6.1). */
export const CRITERIA_RESULT = 'criteria';
export const DIGEST_RESULT = 'digest';
/** The living spec's folder inside `apps/<slug>/`, and the commit trailers the OS reads and writes. */
export const STORIES_DIR = 'stories';
export const STORY_TRAILER = 'Story';
export const OS_SOURCE_TRAILER = 'OS-Source';
export const OS_PROPOSAL_TRAILER = 'OS-Proposal';

export type AppEnv = 'dev' | 'prod';
export type PreviewSlot = 'p1' | 'p2';
export type AppRelease = {
  id: string;
  slug: string;
  env: AppEnv;
  slot?: PreviewSlot;
  sha: string;
  digest: string;
  at: string;
  by: string;
  previous: string | null;
  migrations: { applied: string[]; status: 'ok' | 'failed' | 'none' };
  state: 'deploying' | 'running' | 'failed' | 'rolled-back';
};
export const APP_ENV_NAMESPACE_DEFAULT: Record<AppEnv, string> = { dev: 'apps-dev', prod: 'apps-prod' };

/**
 * The template version an app was created from (spec 2c). 1 = `templates/nextjs-web/` (frozen), 2 =
 * `templates/nextjs-web-v2/` (`nextjs-web@2`, selectable only with the App Builder flag on). `App.templateVersion`
 * absent ⇒ 1.
 */
export type TemplateVersion = 1 | 2;
export const TEMPLATE_VERSIONS: readonly TemplateVersion[] = [1, 2];

/** Absent ⇒ 1: every app created before template versioning, and every app created while the flag is off. */
export function templateVersionOf(app: { templateVersion?: TemplateVersion }): TemplateVersion {
  return app.templateVersion === 2 ? 2 : 1;
}

/** Workstream D: one env's app database, by NAME only (never a credential, never a password). */
export type AppDatabaseRecord = {
  /** `appDbIdent(domain, slug)`: database and role name. */
  name: string;
  /** `appResourceName(domain, slug, 'db')`: the basic-auth Secret in the env namespace. */
  secret: string;
  namespace: string;
  createdAt: string;
  migrations: { applied: string[]; lastRunAt: string | null; status: 'ok' | 'failed' | 'none' };
};

/** The closed set of name parts (spec 2b): previews, Secrets, Jobs. */
export type AppResourcePart = 'db' | 'env' | 'p1' | 'p2' | 'migrate' | 'revoke';
export const APP_RESOURCE_PARTS: readonly AppResourcePart[] = ['db', 'env', 'p1', 'p2', 'migrate', 'revoke'];

/** Kubernetes object names and DNS labels: at most 63 characters. Postgres identifiers: at most 63 bytes. */
export const APP_NAME_MAX = 63;

/** The first 8 hex of sha256("<domain>/<slug>"): the part of every name that makes it unique and stable. */
export function appNameHash(domain: string, slug: string): string {
  return sha256Hex(`${domain}/${slug}`).slice(0, 8);
}

/** `<prefix><domain><sep><slug>` cut so that `<cut><sep><h8>[<sep><part>]` fits; the cut never ends in a separator. */
function keyedName(prefix: string, sep: string, clean: (s: string) => string, domain: string, slug: string, part?: string): string {
  const tail = `${sep}${appNameHash(domain, slug)}${part ? `${sep}${part}` : ''}`;
  const head = `${prefix}${clean(domain)}${sep}${clean(slug)}`;
  const room = APP_NAME_MAX - tail.length;
  let cut = head.length > room ? head.slice(0, room) : head;
  while (cut.endsWith(sep)) cut = cut.slice(0, -1);
  return `${cut}${tail}`;
}

/**
 * `app-<domain>-<slug>-<h8>[-<part>]`, lower-case RFC 1123 (`[a-z0-9-]`, starts with a letter, ends alphanumeric),
 * at most 63 characters; a long domain/slug is cut before the hash, so the hash and the part always survive.
 * Characters outside `[a-z0-9-]` (a domain may carry `.`, `_` or capitals) become `-`. Used for the Deployment,
 * Service, Ingress, TLS Secret, preview Deployments (`p1|p2`), Secrets (`db|env`), and the migrate/REVOKE Jobs.
 */
export function appResourceName(domain: string, slug: string, part?: AppResourcePart): string {
  if (part !== undefined && !APP_RESOURCE_PARTS.includes(part)) throw new Error(`unknown app resource part '${String(part)}'`);
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return keyedName('app-', '-', clean, domain, slug, part);
}

/**
 * `app_<domain>_<slug>_<h8>` in `[a-z0-9_]`, at most 63 bytes (ASCII only, so bytes = characters): the app's
 * Postgres DATABASE and ROLE name. Starts with a letter, so it never needs quoting.
 */
export function appDbIdent(domain: string, slug: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return keyedName('app_', '_', clean, domain, slug);
}

/** The audience of an app token (spec section 8): domain, slug and env, so a Dev token never opens Prod. */
export const appAudience = (domain: string, slug: string, env: AppEnv) => `app:${domain}/${slug}:${env}`;

// ---- SHA-256 (FIPS 180-4), pure, UTF-8 input, hex output. Small inputs only (names); not for bulk data. ----
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const bitLen = msg.length * 8;
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
