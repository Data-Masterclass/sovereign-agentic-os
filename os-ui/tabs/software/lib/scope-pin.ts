/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    The `@sovereign-os` scope pin — the OS's own packages can never come from a registry
 * USER STORY: As the owner of an OS that names its vendored packages `@sovereign-os/ui` and
 *             `@sovereign-os/app-sdk` WITHOUT owning that scope on the public npm registry, I want
 *             every generated app to be unable to fetch that scope from a registry, and I want a
 *             tree that would do so to be refused at the deploy gate, so a stranger who registers
 *             the scope cannot get code into an app.
 * ARCHITECTURE:
 *   The scope is not registered on npmjs.org (checked 2026-11-19) and the owner does not hold an
 *   npm organisation, so the protection cannot be "we own the name". It is two independent things:
 *
 *   1. PREVENTION — a project `.npmrc` in every seed ({@link scopePinNpmrc}) with
 *      `@sovereign-os:registry=<{@link SCOPE_PIN_REGISTRY}>`. npm routes every registry lookup for
 *      a scoped name through that scope's registry, whatever `--registry` says. The host is under
 *      `.invalid`, which RFC 6761 reserves so that it can never resolve: the lookup fails closed
 *      with `getaddrinfo ENOTFOUND sovereign-os-is-vendored-not-published.invalid`, and the host
 *      name is the explanation. `file:` dependencies never consult a registry, so the vendored
 *      packages install exactly as before and the lockfile is byte-identical (both pinned by
 *      `scope-pin.test.ts` / `scaffold-lock.test.ts` and proven with a real `npm ci`).
 *      NOT FAST BY DEFAULT: npm retries a failed fetch twice with 10 s / 60 s back-off, so the
 *      refusal takes about 70 s unless `--fetch-retries=0` is passed. A malformed URL would fail
 *      instantly, but only because of how today's npm parses it — a client that skips a line it
 *      cannot parse would fall back to the public registry, i.e. fail OPEN. An unresolvable host
 *      fails closed in every client that honours the line, so slow-but-closed was chosen.
 *
 *   2. DETECTION — {@link scopePinFindings}, called by `securityScan` (`scan.ts`), i.e. on every
 *      deploy request and layered on top of the live Trivy result. A manifest or lockfile that
 *      would resolve an `@sovereign-os/*` package from anything but a local `file:` path is a
 *      BLOCKING finding; so is an `.npmrc` that points the scope somewhere else.
 *
 *      ONE DELIBERATE EXCEPTION — THE LEGACY TREE. The plain (pre-lockfile) Vite scaffold declares
 *      `"@sovereign-os/ui": "^0.1.0"`: a registry range, with no vendored folder. Every coded app
 *      created before seeds were locked has that manifest, and so does the template fallback a
 *      DECLARATIVE app's deploy request is scanned over. Blocking it would stop all of them from
 *      deploying, for a tree the OS itself never installs (it serves those apps from its own
 *      vendored source). So a plain registry range in a tree with NO `vendor/@sovereign-os/`
 *      folder is reported but does not block: `medium` while the tree has no pin (that is the
 *      exposed state — anyone who runs `npm install` on it asks the public registry), `info` once
 *      the pin is there (the range then fails closed). The remedy is one file: the `.npmrc`.
 *      The same range in a tree that DOES carry the vendored folder is a locked seed whose
 *      protection was edited away, and blocks. The OS does not rewrite a user's repository on
 *      its own; `push_app_files` accepts exactly this `.npmrc` so the owner can add it.
 *
 *   WHAT THIS DOES NOT COVER, stated plainly:
 *     - a machine that runs npm with the project `.npmrc` removed AND a manifest edited to a
 *       registry range, outside the OS (nothing here can see that; the Dockerfile the scaffolds
 *       emit sets the same pin at user level as a second layer);
 *     - `yarn.lock` / `pnpm-lock.yaml` are only searched for a registry URL naming the scope, not
 *       parsed; Yarn Berry does not read `.npmrc` at all;
 *     - a package OUTSIDE the scope that is malicious in its own right.
 *
 *   PURE: no `server-only`, no fs, only a type import — the regeneration script loads it under
 *   plain `node`, and `push-app-files.ts` uses it to recognise the one `.npmrc` an app may carry.
 */
import type { ScaffoldFile, ScanFinding } from '@tabs/software/lib/model';

/** The npm scope the OS vendors its own packages under. */
export const OS_SCOPE = '@sovereign-os';

/**
 * Where the scope's registry points: nowhere. `.invalid` is reserved by RFC 6761 and is never
 * delegated, so this can not be registered by anyone; the label says why the lookup failed.
 */
export const SCOPE_PIN_REGISTRY = 'https://sovereign-os-is-vendored-not-published.invalid/';

export const NPMRC_PATH = '.npmrc';

const PIN_KEY = `${OS_SCOPE}:registry`;

/** The pin as one `.npmrc` line. */
export const SCOPE_PIN_LINE = `${PIN_KEY}=${SCOPE_PIN_REGISTRY}`;

/** The project `.npmrc` every seed carries. Comments are `#` lines, which npm ignores. */
export function scopePinNpmrc(): ScaffoldFile {
  return {
    path: NPMRC_PATH,
    content: [
      `# Packages under ${OS_SCOPE}/ are NOT published to any npm registry. They ship inside this`,
      `# repository (vendor/${OS_SCOPE}/*) and are installed through file: dependencies.`,
      '# The line below makes every registry lookup for that scope fail instead of reaching the',
      '# public registry, where a stranger could publish a package under the same name.',
      '# Do not remove or change it. (.invalid can never resolve: RFC 6761.)',
      SCOPE_PIN_LINE,
      '',
    ].join('\n'),
  };
}

/** `key=value` pairs of an `.npmrc`, comments and blank lines dropped, quotes removed. */
function npmrcEntries(content: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    out.push([line.slice(0, eq).trim(), value]);
  }
  return out;
}

const sameRegistry = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Every value an `.npmrc` gives the scope's registry (npm takes the last; all of them are judged). */
function scopeRegistries(content: string): string[] {
  return npmrcEntries(content)
    .filter(([k]) => k.toLowerCase() === PIN_KEY)
    .map(([, v]) => v);
}

/** True when this `.npmrc` pins the scope, and to nothing else. */
export function hasScopePin(content: string): boolean {
  const values = scopeRegistries(content);
  return values.length > 0 && values.every((v) => sameRegistry(v, SCOPE_PIN_REGISTRY));
}

/**
 * True when `content` is an `.npmrc` that does nothing but pin the scope: the only one an app may
 * push (`push-app-files.ts`). Any other key — a token, another registry — is still refused.
 */
export function isScopePinOnlyNpmrc(content: string): boolean {
  const entries = npmrcEntries(content);
  return entries.length > 0 && entries.every(([k]) => k.toLowerCase() === PIN_KEY) && hasScopePin(content);
}

const RANGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(content: string): Json | null {
  try {
    const v: unknown = JSON.parse(content);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

const inScope = (name: string): boolean => name.toLowerCase().startsWith(`${OS_SCOPE}/`);
/** A specifier npm installs from the local disk without asking a registry. */
const isLocalSpec = (spec: string): boolean => /^file:/i.test(spec.trim());
/** `"anything": "npm:@sovereign-os/ui@1"` — the scope reached through an alias. */
const aliasesScope = (spec: string): boolean => new RegExp(`^npm:${OS_SCOPE}/`, 'i').test(spec.trim());
const hasScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(s);
const outsideNodeModules = (path: string): boolean => !path.split('/').includes('node_modules');
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const REMEDY =
  `Packages under ${OS_SCOPE}/ are not published to any registry: they ship inside the app under ` +
  `vendor/${OS_SCOPE}/ and must be declared as file: dependencies (for example ` +
  `"file:./vendor/${OS_SCOPE}/ui"). Anything else makes npm look the name up on a registry, where ` +
  `anyone could publish a package under it. Point it back at the vendored folder, regenerate the ` +
  `lockfile (npm install --package-lock-only) and request the deploy again.`;

function blocking(path: string, name: string, what: string): ScanFinding {
  return {
    category: 'deps',
    severity: 'critical',
    title: `${name} would be fetched from a package registry`,
    detail: `${path} ${what}. ${REMEDY}`,
    path,
  };
}

/** A registry version range or tag (`^0.1.0`, `latest`) — no URL, no git remote, no alias. */
const isPlainRange = (spec: string): boolean => !/[:/]/.test(spec.trim());

function manifestFindings(
  path: string,
  manifest: Json,
  legacyTree: boolean,
): { findings: ScanFinding[]; usesScope: boolean; legacyRanges: number } {
  const findings: ScanFinding[] = [];
  let usesScope = false;
  let legacyRanges = 0;
  for (const field of RANGE_FIELDS) {
    const deps = manifest[field];
    if (!isObj(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue;
      if (inScope(name)) {
        usesScope = true;
        if (isLocalSpec(spec)) continue;
        if (legacyTree && isPlainRange(spec)) {
          // The pre-lockfile scaffold's own manifest: reported, never blocking (see the header).
          legacyRanges += 1;
          findings.push({
            category: 'deps',
            severity: 'info',
            title: `${name} is declared as a registry version, but it is not published anywhere`,
            detail:
              `${path} declares "${name}": "${spec}" in ${field}. This is the manifest older apps were created ` +
              `with. The OS serves the app from its own copy of ${OS_SCOPE}/*, so nothing is fetched here; an ` +
              `"npm install" run on this tree elsewhere would ask a registry for that name.`,
            path,
          });
          continue;
        }
        findings.push(blocking(path, name, `declares "${name}": "${spec}" in ${field}, which is not a local file: path`));
      } else if (aliasesScope(spec)) {
        usesScope = true;
        findings.push(blocking(path, spec.trim().slice(4), `declares "${name}": "${spec}" in ${field}, an alias that resolves the scope from a registry`));
      }
    }
  }
  return { findings, usesScope, legacyRanges };
}

/** npm lockfileVersion 2/3: every installed copy of a scoped package must be a link to a local folder. */
function lockPackagesFindings(path: string, packages: Json): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!isObj(entry)) continue;
    const at = key.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const name = typeof entry.name === 'string' ? entry.name : key.slice(at + 'node_modules/'.length);
    if (!inScope(name)) continue;
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : null;
    const local = resolved !== null && (isLocalSpec(resolved) || (entry.link === true && !hasScheme(resolved)));
    if (local) continue;
    out.push(
      blocking(
        path,
        name,
        resolved === null
          ? `holds an entry for ${name} (${key}) with no local source recorded`
          : `resolves ${name} from ${resolved}, which is not a folder inside the app`,
      ),
    );
  }
  return out;
}

/** npm lockfileVersion 1: a nested `dependencies` table whose `version` is the specifier for local packages. */
function lockV1Findings(path: string, deps: Json, depth = 0): ScanFinding[] {
  const out: ScanFinding[] = [];
  if (depth > 20) return out;
  for (const [name, entry] of Object.entries(deps)) {
    if (!isObj(entry)) continue;
    if (inScope(name)) {
      const version = typeof entry.version === 'string' ? entry.version : '';
      if (!isLocalSpec(version)) {
        out.push(blocking(path, name, `resolves ${name} as ${version || 'an unnamed version'}${typeof entry.resolved === 'string' ? ` from ${entry.resolved}` : ''}, which is not a local file: path`));
      }
    }
    if (isObj(entry.dependencies)) out.push(...lockV1Findings(path, entry.dependencies, depth + 1));
  }
  return out;
}

const NPM_LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const TEXT_LOCKS = new Set(['yarn.lock', 'pnpm-lock.yaml']);
/** A URL naming the scope, as a registry tarball or git remote would (`/@sovereign-os/` or `%2f`). */
const SCOPE_URL = new RegExp(`[a-z][a-z0-9+.-]*://[^\\s"']*${OS_SCOPE}(?:/|%2f)[^\\s"']*`, 'i');

/**
 * Everything in a tree that would resolve an `@sovereign-os/*` package from somewhere other than
 * the app's own vendored folder, as review-card findings.
 *
 *   BLOCKING (`critical`): a manifest URL / git reference / alias for the scope, or a version range
 *   in a tree that carries `vendor/@sovereign-os/`; a lockfile entry for the scope that is not a
 *   local link; an `.npmrc` pointing the scope at another registry.
 *   NEVER BLOCKING: a version range in a legacy tree (no vendored folder) — `info` per dependency;
 *   and "the tree uses the scope but its root `.npmrc` does not pin it" — `medium` when such a
 *   range exists (the exposed state), `info` otherwise.
 */
export function scopePinFindings(files: ScaffoldFile[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  let usesScope = false;
  let rootPinned = false;
  let legacyRanges = 0;
  const legacyTree = !files.some((f) => f.path.replace(/^\.\//, '').startsWith(`vendor/${OS_SCOPE}/`));

  for (const f of files) {
    const path = f.path.replace(/^\.\//, '');
    if (!outsideNodeModules(path)) continue;
    const name = baseName(path);

    if (name === 'package.json') {
      const manifest = parseJson(f.content);
      if (!manifest) continue;
      const m = manifestFindings(path, manifest, legacyTree);
      usesScope ||= m.usesScope;
      legacyRanges += m.legacyRanges;
      out.push(...m.findings);
    } else if (NPM_LOCKS.has(name)) {
      const lock = parseJson(f.content);
      if (!lock) continue;
      if (isObj(lock.packages)) out.push(...lockPackagesFindings(path, lock.packages));
      else if (isObj(lock.dependencies)) out.push(...lockV1Findings(path, lock.dependencies));
    } else if (TEXT_LOCKS.has(name)) {
      const hit = SCOPE_URL.exec(f.content);
      if (hit) out.push(blocking(path, `${OS_SCOPE}/*`, `resolves a package of the scope from ${hit[0]}`));
    } else if (name === NPMRC_PATH) {
      const foreign = scopeRegistries(f.content).filter((v) => !sameRegistry(v, SCOPE_PIN_REGISTRY));
      if (foreign.length > 0) {
        out.push({
          category: 'deps',
          severity: 'critical',
          title: `${OS_SCOPE}/* is pointed at a package registry`,
          detail:
            `${path} sets ${PIN_KEY}=${foreign[0]}. Packages under ${OS_SCOPE}/ are not published anywhere; ` +
            `whoever controls that registry could supply them. The only accepted value is ${SCOPE_PIN_REGISTRY} ` +
            `(a host that can never resolve). Restore that line and request the deploy again.`,
          path,
        });
      } else if (path === NPMRC_PATH && hasScopePin(f.content)) {
        rootPinned = true;
      }
    }
  }

  if (usesScope && !rootPinned) {
    out.push({
      category: 'deps',
      // `medium` is visible on the card and does not block (only high/critical and secrets do).
      severity: legacyRanges > 0 ? 'medium' : 'info',
      title: `${OS_SCOPE}/* is not pinned away from the public registry`,
      detail:
        `This app uses ${OS_SCOPE}/* packages and has no root ${NPMRC_PATH} with the line "${SCOPE_PIN_LINE}". ` +
        `Apps created before the pin existed look like this; the OS does not change your repository for you. ` +
        (legacyRanges > 0
          ? `Its package.json asks for ${OS_SCOPE}/* by version, so an "npm install" on this tree would look the ` +
            `name up on the public registry, where anyone could publish it. `
          : `Every ${OS_SCOPE}/* dependency is a file: path today; the pin is what stops a later edit from ` +
            `reaching the public registry. `) +
        `Add a ${NPMRC_PATH} with exactly that line (push_app_files accepts it) to close this.`,
      path: NPMRC_PATH,
    });
  }
  return out;
}
