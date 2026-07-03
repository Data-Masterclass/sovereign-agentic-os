/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Hermes code-execution sandbox — RuntimeClass selection + the always-on refusal
 * floor (hermes-agent-integration-plan.md §9 "Sandbox").
 *
 * Code runs under a REAL kernel-isolated runtime, NEVER host-local/off/YOLO:
 *   • Default: Kata Containers microVM (per-pod guest kernel via KVM) — the
 *     `kata-qemu` RuntimeClass, ideally via the Agent Sandbox CRD.
 *   • Fallback: gVisor (`gvisor`, user-space syscall isolation) when the node
 *     lacks nested virtualization / KVM (e.g. kind — no nested KVM).
 * A preflight probes SKE nodes for nested KVM to pick Kata-vs-gVisor; kind always
 * resolves to gVisor. This module is the PURE decision logic; the chart templates
 * the actual RuntimeClass objects + the preflight Job.
 *
 * It also owns the two fail-closed refusals the validation gate exercises: a
 * blocklisted egress host and a hardline shell command are REFUSED before they run.
 */

export const KATA_RUNTIME_CLASS = 'kata-qemu';
export const GVISOR_RUNTIME_CLASS = 'gvisor';

/** RuntimeClasses this platform will ever run agent code under. Nothing else. */
export const ALLOWED_RUNTIME_CLASSES = [KATA_RUNTIME_CLASS, GVISOR_RUNTIME_CLASS] as const;
export type RuntimeClassName = (typeof ALLOWED_RUNTIME_CLASSES)[number];

export type SandboxEnvironment = {
  /** 'kind' → never has nested KVM → gVisor. 'ske' → depends on the preflight. */
  platform: 'kind' | 'ske';
  /** Result of the nested-KVM preflight (undefined on kind — assumed false). */
  nestedKvm?: boolean;
};

export type RuntimeSelection = {
  runtimeClass: RuntimeClassName;
  reason: string;
  /** True when a real microVM (Kata) is used; false for the gVisor fallback. */
  microVm: boolean;
};

/**
 * Pick the RuntimeClass. Kata (microVM) is preferred wherever nested KVM exists;
 * everywhere else (kind, or an SKE node pool without nested virt) we fall back to
 * gVisor. There is NO path to host-local execution.
 */
export function selectRuntimeClass(env: SandboxEnvironment): RuntimeSelection {
  if (env.platform === 'kind') {
    return {
      runtimeClass: GVISOR_RUNTIME_CLASS,
      reason: 'kind has no nested KVM — gVisor (user-space isolation) fallback',
      microVm: false,
    };
  }
  // SKE: use the preflight result. Only Kata when nested KVM is confirmed.
  if (env.nestedKvm === true) {
    return { runtimeClass: KATA_RUNTIME_CLASS, reason: 'SKE node has nested KVM — Kata microVM', microVm: true };
  }
  return {
    runtimeClass: GVISOR_RUNTIME_CLASS,
    reason: 'SKE node lacks nested KVM (preflight) — gVisor fallback',
    microVm: false,
  };
}

/**
 * Interpret the SKE nested-KVM preflight (a Job that tests for /dev/kvm). Given
 * the probe's finding, return whether Kata is viable — the input to
 * {@link selectRuntimeClass} for an SKE pool.
 */
export function nestedKvmPreflight(probe: { devKvmPresent: boolean }): { nestedKvm: boolean; verdict: string } {
  return probe.devKvmPresent
    ? { nestedKvm: true, verdict: '/dev/kvm present — Kata microVM available' }
    : { nestedKvm: false, verdict: '/dev/kvm absent — use gVisor' };
}

/** A chosen RuntimeClass is always one of the two isolation runtimes, never host. */
export function assertIsolated(runtimeClass: string): void {
  if (!(ALLOWED_RUNTIME_CLASSES as readonly string[]).includes(runtimeClass)) {
    throw new Error(
      `sandbox runtimeClass '${runtimeClass}' is not kernel-isolated — only ${ALLOWED_RUNTIME_CLASSES.join('/')} are allowed (never host-local/off/YOLO)`,
    );
  }
}

// ------------------------------------------------------------ fail-closed refusals --

export type Refusal = { allowed: boolean; reason: string };

function hostOf(target: string): string {
  const t = target.trim();
  try {
    return new URL(t.includes('://') ? t : `http://${t}`).hostname.toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

/**
 * SSRF-style egress refusal (fail-closed). A target is refused if its host is on
 * the website blocklist OR resolves to a private/loopback/link-local/metadata
 * range. Anything not explicitly on the egress allowlist is ALSO refused.
 */
export function refuseEgress(target: string, opts: { allowlist: string[]; blocklist: string[] }): Refusal {
  const host = hostOf(target);
  if (!host) return { allowed: false, reason: 'empty target — refused (fail-closed)' };
  if (opts.blocklist.some((b) => host === b.toLowerCase() || host.endsWith(`.${b.toLowerCase()}`))) {
    return { allowed: false, reason: `host '${host}' is on the website blocklist — refused` };
  }
  if (isPrivateHost(host)) {
    return { allowed: false, reason: `host '${host}' is private/loopback/link-local/metadata — SSRF refused` };
  }
  if (!opts.allowlist.some((a) => host === a.toLowerCase() || host.endsWith(`.${a.toLowerCase()}`))) {
    return { allowed: false, reason: `host '${host}' is not on the egress allowlist — refused (default-deny)` };
  }
  return { allowed: true, reason: `host '${host}' is allowlisted` };
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '169.254.169.254' || host === 'metadata.google.internal') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local / metadata
  return false;
}

/**
 * Hardline command refusal (fail-closed). A command is refused if it matches any
 * hardline-blocklist entry (substring, normalized) — regardless of the profile's
 * command allowlist. This is the always-on floor.
 */
export function refuseCommand(command: string, hardlineBlocklist: string[]): Refusal {
  const norm = command.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const bad of hardlineBlocklist) {
    const pattern = bad.replace(/\s+/g, ' ').trim().toLowerCase();
    if (matchesHardline(norm, pattern)) {
      return { allowed: false, reason: `command matches hardline blocklist ('${bad}') — refused` };
    }
  }
  return { allowed: true, reason: 'command is not hardline-blocked' };
}

/**
 * A hardline entry with a pipe (e.g. `curl | sh`) matches if its segments appear
 * IN ORDER anywhere in the command (so `curl http://x | sh` is still caught);
 * a plain entry is a straight substring match.
 */
function matchesHardline(command: string, pattern: string): boolean {
  if (!pattern.includes('|')) return command.includes(pattern);
  const segs = pattern.split('|').map((s) => s.trim()).filter(Boolean);
  let from = 0;
  for (const seg of segs) {
    const at = command.indexOf(seg, from);
    if (at < 0) return false;
    from = at + seg.length;
  }
  return true;
}
