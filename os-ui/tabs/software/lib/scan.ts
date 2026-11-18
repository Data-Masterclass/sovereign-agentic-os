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
