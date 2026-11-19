/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// server-only (review L2, 2026-11-18): this module now DECIDES whether a scan verdict may be
// issued, by reading the process environment. A decision like that must be unreachable from the
// browser bundle, where `process.env` is whatever the build inlined — a client-side caller would
// get a verdict from a different switch than the server used. Both existing importers
// (`adapters.ts`, `review.ts`) are already server-only, so this adds no constraint; it prevents
// the next one. The test loader stubs `server-only`, so the unit tests are unaffected.
import 'server-only';
import type { ScanCategory, ScanFinding, ScanMode, ScanResult, ScaffoldFile } from '@tabs/software/lib/model';
import { offlineMockAllowed } from '@core/kernel/offline-mock';
import { config } from '@core/kernel/config';
import { runTrivyScan, type TrivyScanOpts } from '@tabs/software/lib/scan-trivy';

/**
 * The security scanner that feeds the Builder review card (Software golden path
 * §D — CI runs tests + a security scan: SAST · deps · secret-scan). This is a
 * REAL, deterministic baseline that runs offline (no external scanner needed) so
 * the deploy-review gate is demonstrable on a laptop; a live deploy swaps in the
 * real scanners (Semgrep / Trivy / gitleaks) behind the same shape.
 *
 * The gate rule (tested): a deploy MAY proceed only when `passed` is true, i.e.
 * NO secret leaked and NO high/critical SAST or dependency finding. A leaked
 * secret is always treated as blocking regardless of count.
 */

// --- secret-scan: high-signal credential patterns (gitleaks-style baseline) ---
const SECRET_PATTERNS: { re: RegExp; title: string }[] = [
  { re: /AKIA[0-9A-Z]{16}/, title: 'AWS access key id' },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, title: 'Private key material' },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/, title: 'Slack token' },
  { re: /gh[pousr]_[0-9A-Za-z]{20,}/, title: 'GitHub token' },
  { re: /sk-[a-zA-Z0-9]{20,}/, title: 'API secret key (sk-…)' },
  {
    re: /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    title: 'Hardcoded credential assignment',
  },
];

// --- SAST: dangerous code patterns ---
const SAST_PATTERNS: { re: RegExp; severity: ScanFinding['severity']; title: string }[] = [
  { re: /\beval\s*\(/, severity: 'high', title: 'Use of eval()' },
  { re: /child_process|execSync\s*\(|\bexec\s*\(/, severity: 'high', title: 'Shell/command execution' },
  { re: /dangerouslySetInnerHTML/, severity: 'medium', title: 'Raw HTML injection (XSS risk)' },
  { re: /https?:\/\/[^"'\s)]+/, severity: 'low', title: 'Hardcoded outbound URL (egress review)' },
];

// --- deps: a tiny known-bad version list (stand-in for a Trivy/OSV DB) ---
const KNOWN_BAD_DEPS: Record<string, { range: RegExp; severity: ScanFinding['severity']; cve: string }> = {
  lodash: { range: /^[\^~]?4\.17\.(1[0-9]|20)$/, severity: 'high', cve: 'CVE-2021-23337 (prototype pollution)' },
  'next': { range: /^[\^~]?(?:[0-9]|1[0-3])\./, severity: 'medium', cve: 'multiple — upgrade to 14+' },
};

function emptySummary(): Record<ScanCategory, number> {
  return { sast: 0, deps: 0, secrets: 0 };
}

function scanSecrets(files: ScaffoldFile[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const f of files) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(f.content)) {
        out.push({
          category: 'secrets',
          severity: 'critical',
          title: `Possible committed secret: ${p.title}`,
          detail: 'Secrets must live in External Secrets / Secrets Manager, never in git.',
          path: f.path,
        });
      }
    }
  }
  return out;
}

function scanSast(files: ScaffoldFile[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const f of files) {
    // Only scan source-ish files; skip manifests/docs to cut URL noise.
    const isSource = /\.(ts|tsx|js|jsx|py|mjs|cjs)$/.test(f.path);
    for (const p of SAST_PATTERNS) {
      if (p.severity === 'low' && !isSource) continue;
      if (p.re.test(f.content)) {
        out.push({ category: 'sast', severity: p.severity, title: p.title, detail: `Matched in ${f.path}.`, path: f.path });
      }
    }
  }
  return out;
}

function scanDeps(files: ScaffoldFile[]): ScanFinding[] {
  const out: ScanFinding[] = [];
  const pkg = files.find((f) => f.path === 'package.json' || f.path.endsWith('/package.json'));
  if (!pkg) return out;
  let deps: Record<string, string> = {};
  try {
    const j = JSON.parse(pkg.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
  } catch {
    out.push({ category: 'deps', severity: 'low', title: 'Unparseable package.json', detail: 'Could not read dependencies.', path: pkg.path });
    return out;
  }
  for (const [name, version] of Object.entries(deps)) {
    const bad = KNOWN_BAD_DEPS[name];
    if (bad && bad.range.test(version)) {
      out.push({
        category: 'deps',
        severity: bad.severity,
        title: `Vulnerable dependency: ${name}@${version}`,
        detail: bad.cve,
        path: pkg.path,
      });
    }
  }
  return out;
}

const BLOCKING = new Set(['high', 'critical']);

/**
 * Run the full scan over the app's repo files. `passed` is true only when there
 * is NO secret finding and NO high/critical SAST/deps finding — the exact gate
 * the review card enforces.
 */
export function securityScan(files: ScaffoldFile[], mode?: ScanMode): ScanResult {
  const findings = [...scanSecrets(files), ...scanSast(files), ...scanDeps(files)];
  const summary = emptySummary();
  for (const f of findings) summary[f.category] += 1;
  const hasSecret = findings.some((f) => f.category === 'secrets');
  const hasBlocking = findings.some((f) => BLOCKING.has(f.severity));
  const clean = !hasSecret && !hasBlocking;
  // THE HONESTY GATE (2026-11-18). `mode` used to DEFAULT to 'offline-mock', so it was never a
  // decision: on the cluster every card said `offline-mock` and `decideDeploy` \u2014 which approves
  // only on `card.scan.passed` \u2014 was green by construction, a green tick for a scan no engine
  // ran. A caller that injects a real engine ('live') is unaffected; an absent engine is now
  // reported as `unavailable` with `passed: false` unless this deployment explicitly asked for the
  // teaching flow. The findings above are REAL either way and are always returned: refusing a
  // VERDICT is not the same as hiding evidence.
  const resolved: ScanMode = mode ?? (offlineMockAllowed() ? 'offline-mock' : 'unavailable');
  const scannedAt = new Date().toISOString();
  if (resolved === 'unavailable') {
    return {
      mode: 'unavailable',
      passed: false,
      findings,
      summary,
      scannedAt,
      unavailable: true,
      reason:
        'No security scanner engine ran: this deployment has no live scanner wired (Semgrep / ' +
        'Trivy / gitleaks) and refuses to issue a passing verdict from the offline baseline. ' +
        `The ${findings.length} finding(s) listed are real and were read from the committed files; ` +
        'the VERDICT is withheld, so this deploy cannot be approved until a scanner is configured.',
    };
  }
  return { mode: resolved, passed: clean, findings, summary, scannedAt };
}

// ------------------------------------------------------ The live engine's door -----

export type ResolveScanOpts = {
  /** Defaults to `config.softwareScannerEnabled` (the chart's `osUI.software.scanner.enabled`). */
  scannerEnabled?: boolean;
  /** Passed through to the adapter — the injection point the tests use. */
  trivy?: TrivyScanOpts;
};

/**
 * THE ONE DOOR a deploy request walks through to get a scan.
 *
 * `securityScan` above is unchanged on purpose: it is the decider the kernel tripwire pins, and
 * it is what produces the baseline EVIDENCE. This is the live engine's door beside it:
 *
 *   1. An EXPLICIT `mode` from the caller wins. That injection point pre-dates this change
 *      (#56: "a caller that injects a real engine ('live') is unaffected") and the whole unit
 *      suite leans on it, so it keeps its exact meaning.
 *   2. SCANNER OFF  -> `securityScan(files)`, i.e. the #56 behaviour verbatim, with the reason
 *      naming the flag that turned it off instead of claiming nothing is wired.
 *   3. SCANNER ON   -> Trivy, as one Kubernetes Job (`scan-trivy.ts`). `mode: 'live'` is
 *      returned ONLY when that Job completed and its framed report parsed — and the BASELINE's
 *      own known-bad dependency list and secret patterns are layered ON TOP of the live result
 *      (see below), never replaced by it.
 *   4. THE SCAN FAILED on a reachable cluster -> `unavailable` with the cause, FULL STOP. It does
 *      NOT degrade to a green `offline-mock`, not even where `OS_OFFLINE_MOCK=allow` (PR #63
 *      review M6): a scanner that is wired and broken is a different fact from a laptop with no
 *      cluster, and the second one must not launder the first.
 *   5. THERE IS NO CLUSTER AT ALL -> delegate to `securityScan(files)`, which decides between the
 *      laptop's honestly-labelled `offline-mock` and a cluster's `unavailable`. That is
 *      `OS_OFFLINE_MOCK`'s job and this function does not second-guess it. The scanner's reason is
 *      attached either way, so the card always says what was tried.
 *
 * There is no branch in which a scanner that could not run yields `passed: true`.
 */
export async function resolveScan(
  slug: string,
  files: ScaffoldFile[],
  mode?: ScanMode,
  opts: ResolveScanOpts = {},
): Promise<ScanResult> {
  if (mode) return securityScan(files, mode);

  const enabled = opts.scannerEnabled ?? config.softwareScannerEnabled;
  if (!enabled) {
    return withScannerReason(
      securityScan(files),
      'The live security scanner is switched off for this deployment ' +
        '(`osUI.software.scanner.enabled: false`), so no engine ran and there is no verdict to ' +
        'give. Turn it on, or wire another engine behind `resolveScan`.',
    );
  }

  const live = await runTrivyScan(slug, files, opts.trivy ?? {});
  if (!live.ok) {
    // M6: a WIRED scanner that failed is never laundered into a green offline-mock result. Only
    // "there is no Kubernetes API at all" — the laptop — may fall back, and even then the
    // scanner's reason travels with the result.
    if (live.kind === 'scan-failed') {
      // The baseline is read ONCE (re-review L-2): it re-scans every file, and the findings and
      // the summary are two views of one pass, not two passes.
      const evidence = securityScan(files, 'offline-mock');
      return {
        mode: 'unavailable',
        passed: false,
        findings: evidence.findings,
        summary: evidence.summary,
        scannedAt: new Date().toISOString(),
        unavailable: true,
        reason: live.reason,
      };
    }
    return withScannerReason(securityScan(files), live.reason);
  }

  // THE LIVE VERDICT, with the baseline LAYERED ON TOP (PR #63 review H1). Trivy resolves
  // dependencies from lockfiles; our scaffolds commit none, so its `deps` coverage can be empty
  // where the baseline's two-entry known-bad list would still have flagged `lodash@4.17.20`.
  // Dropping the baseline would therefore have made the live scanner a REGRESSION on exactly the
  // trees this product generates. Both run; the strictest answer wins.
  //
  // Note what is NOT here: no `offlineMockAllowed()` call. A real engine's real answer is not a
  // fabrication and is not that lever's business.
  const baseline = securityScan(files, 'offline-mock');
  const extra = layeredBaselineFindings(baseline.findings, live.findings);
  const findings = [...live.findings, ...extra];
  const summary: Record<ScanCategory, number> = { ...live.summary };
  for (const f of extra) summary[f.category] += 1;
  const extraBlocks = extra.some((f) => f.category === 'secrets' || f.severity === 'high' || f.severity === 'critical');
  return {
    mode: 'live',
    passed: live.passed && !extraBlocks,
    findings,
    summary,
    scannedAt: new Date().toISOString(),
    engine: extra.length > 0 ? `${live.engine} + offline baseline` : live.engine,
    notRun: live.notRun,
    ...(live.reason ? { reason: live.reason } : {}),
    // What the card's capped list does NOT show. The deploy gate reads these rather than
    // re-deriving severity from a truncated list (re-review L-B).
    ...(live.truncated ? { truncated: true as const } : {}),
    ...(live.blockingBeyondCap ? { blockingBeyondCap: true as const } : {}),
  };
}

/**
 * The baseline findings worth carrying alongside a live result: `deps` (its known-bad version
 * list, which does not need a lockfile) and `secrets` (its credential patterns). `sast` is
 * deliberately EXCLUDED — those patterns are heuristics over source text, `notRun` says sast was
 * not covered, and adding them would contradict that label.
 *
 * Deduped two ways: an identical title for the same path, and — for secrets — any file the live
 * engine already flagged, since two engines naming one leaked key is noise, not two leaks.
 */
function layeredBaselineFindings(baseline: ScanFinding[], live: ScanFinding[]): ScanFinding[] {
  const seen = new Set(live.map((f) => `${f.category}|${f.path ?? ''}|${f.title}`));
  const liveSecretPaths = new Set(live.filter((f) => f.category === 'secrets').map((f) => f.path ?? ''));
  const out: ScanFinding[] = [];
  for (const f of baseline) {
    if (f.category === 'sast') continue;
    if (f.category === 'secrets' && liveSecretPaths.has(f.path ?? '')) continue;
    const key = `${f.category}|${f.path ?? ''}|${f.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f, detail: `${f.detail} (offline baseline check, layered on the live scan.)` });
  }
  return out;
}

/**
 * Replace the baseline's generic "nothing is wired" reason with the scanner's REAL cause. On an
 * `unavailable` result it IS the reason; on the laptop's `offline-mock` result it is attached
 * alongside, so the card can always say what was attempted without the teaching flow's shape
 * changing (`unavailable` stays unset, `passed` stays the baseline's answer).
 */
function withScannerReason(result: ScanResult, reason: string): ScanResult {
  return { ...result, reason };
}
