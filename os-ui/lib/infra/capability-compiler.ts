/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Capability-profile -> OPA compiler (Connections golden path §3, data-policy-
 * compiler.md pattern: ONE source, compiled to a data bundle + a small generic
 * Rego that reads it; policy LOGIC stays static, the per-connection/grant DATA is
 * compiled). The capability profile a Builder authors in the UI (per-tool
 * Off/Read/Write-approval/Write-bounded/Blocked + limits) is the single source;
 * this module compiles it to:
 *   1. an OPA DATA bundle (JSON, hot-reloaded by OPA) — the durable artifact, and
 *   2. a pure `decide()` evaluator that mirrors the generic Rego, so the SAME rule
 *      is enforced offline (the laptop teaching flow) and online (live OPA).
 *
 * PURE module (no secrets, no server-only): both `lib/agent-governed.ts` (the
 * offline mirror) and `lib/connections.ts` (which pushes the bundle) import it, so
 * there is exactly ONE decision rule — no drift between the two enforcement points
 * (the conformance guarantee the data-policy-compiler demands).
 */

export type CapMode = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';
export type Effect = 'allow' | 'deny' | 'requires_approval';

/** A single compiled per-tool rule in the OPA data bundle. */
export type OpaToolRule = {
  mode: CapMode;
  write: boolean;
  /** Bounded-write argument bound (amount <= maxAmount). */
  maxAmount?: number;
  /** Argument the bound applies to (default 'amount'). */
  boundArg?: string;
  dataScope?: string;
};

/** The compiled bundle for one connection principal. */
export type OpaConnectionBundle = {
  principal: string;
  /** tool name -> compiled rule. */
  tools: Record<string, OpaToolRule>;
  /** agent principal -> the EXACT tool names that agent may call (restrict-only). */
  grants: Record<string, string[]>;
};

export type CompilerToolInput = {
  name: string;
  mode: CapMode;
  write: boolean;
  maxAmount?: number;
  boundArg?: string;
  dataScope?: string;
};

export type CompilerGrant = { agent: string; tools: string[] };

/**
 * Compile a connection's capability profile (+ per-agent grants) into the OPA
 * data bundle for that principal. Deterministic and pure.
 */
export function compileConnectionProfile(
  principal: string,
  tools: CompilerToolInput[],
  grants: CompilerGrant[] = [],
): OpaConnectionBundle {
  const toolRules: Record<string, OpaToolRule> = {};
  for (const t of tools) {
    toolRules[t.name] = {
      mode: t.mode,
      write: t.write,
      ...(t.maxAmount !== undefined ? { maxAmount: t.maxAmount } : {}),
      ...(t.boundArg ? { boundArg: t.boundArg } : {}),
      ...(t.dataScope ? { dataScope: t.dataScope } : {}),
    };
  }
  const grantMap: Record<string, string[]> = {};
  for (const g of grants) grantMap[g.agent] = [...g.tools];
  return { principal, tools: toolRules, grants: grantMap };
}

/** The tool names a connection actually EXPOSES (enabled + in-scope; not Off/Blocked). */
export function exposedTools(bundle: OpaConnectionBundle): string[] {
  return Object.entries(bundle.tools)
    .filter(([, r]) => r.mode === 'Read' || r.mode === 'Write-approval' || r.mode === 'Write-bounded')
    .map(([name]) => name);
}

export type Decision = { effect: Effect; reason: string; mode?: CapMode };

/**
 * Evaluate one compiled rule against call args. This is the GENERIC policy logic
 * (the Rego mirror) — Off/Blocked deny, Read allow, Write-approval holds,
 * Write-bounded allows within the bound and denies outside it.
 */
export function evaluateRule(rule: OpaToolRule, args: Record<string, unknown> = {}): Decision {
  switch (rule.mode) {
    case 'Off':
      return { effect: 'deny', reason: 'tool is Off — not exposed', mode: 'Off' };
    case 'Blocked':
      return { effect: 'deny', reason: 'tool is Blocked — forbidden (needs an Admin override)', mode: 'Blocked' };
    case 'Read':
      return { effect: 'allow', reason: 'read — granted', mode: 'Read' };
    case 'Write-approval':
      return { effect: 'requires_approval', reason: 'write — held for human approval', mode: 'Write-approval' };
    case 'Write-bounded': {
      if (rule.maxAmount !== undefined) {
        const arg = rule.boundArg ?? 'amount';
        const amount = Number((args ?? {})[arg]);
        if (!Number.isFinite(amount)) {
          return { effect: 'deny', reason: `bounded write requires a numeric ${arg} <= ${rule.maxAmount}`, mode: 'Write-bounded' };
        }
        if (amount > rule.maxAmount) {
          return { effect: 'deny', reason: `${arg} ${amount} exceeds the bound (<= ${rule.maxAmount})`, mode: 'Write-bounded' };
        }
        return { effect: 'allow', reason: `within bound (<= ${rule.maxAmount})`, mode: 'Write-bounded' };
      }
      return { effect: 'allow', reason: 'within bound', mode: 'Write-bounded' };
    }
    default:
      return { effect: 'deny', reason: 'unknown mode', mode: rule.mode };
  }
}

/**
 * Decide a tool call against the compiled bundle, honoring a per-agent grant
 * (restrict-only). This is what a live OPA evaluating the bundle returns, and what
 * the offline mirror returns — by construction the same function, so they cannot
 * drift.
 */
export function decide(
  bundle: OpaConnectionBundle,
  tool: string,
  args: Record<string, unknown> = {},
  asAgent?: string,
): Decision {
  const rule = bundle.tools[tool];
  if (!rule) return { effect: 'deny', reason: `tool ${tool} is not exposed by this connection` };
  if (asAgent) {
    const allowed = bundle.grants[asAgent];
    if (allowed && !allowed.includes(tool)) {
      return { effect: 'deny', reason: `agent ${asAgent} is granted a narrower scope; ${tool} is not in the grant`, mode: rule.mode };
    }
  }
  return evaluateRule(rule, args);
}

/**
 * The small, STATIC generic Rego that reads the compiled data bundle. We ship the
 * data bundle (compiled per change) + this fixed policy; OPA hot-reloads the data.
 * Kept as a string artifact so a real deploy can write it to the OPA policy dir.
 */
export const GENERIC_REGO = `package connections.authz
# Generic policy — reads the compiled per-connection data bundle at
# data.connections[principal]. The per-tool/grant DATA is compiled by
# lib/capability-compiler.ts; this LOGIC is static (no drift).
import future.keywords.if
import future.keywords.in

default decision := {"effect": "deny", "reason": "no matching connection rule"}

rule := r if {
	r := data.connections[input.principal].tools[input.tool]
}

# restrict-only grant: if the agent has a grant, the tool must be in it
grant_ok if {
	not input.asAgent
}
grant_ok if {
	allowed := data.connections[input.principal].grants[input.asAgent]
	input.tool in allowed
}
grant_ok if {
	not data.connections[input.principal].grants[input.asAgent]
}

decision := {"effect": "deny", "reason": "grant excludes tool"} if {
	rule
	not grant_ok
}
decision := {"effect": "deny", "reason": "Off"} if { grant_ok; rule.mode == "Off" }
decision := {"effect": "deny", "reason": "Blocked"} if { grant_ok; rule.mode == "Blocked" }
decision := {"effect": "allow", "reason": "read"} if { grant_ok; rule.mode == "Read" }
decision := {"effect": "requires_approval", "reason": "write"} if { grant_ok; rule.mode == "Write-approval" }
decision := {"effect": "allow", "reason": "within bound"} if {
	grant_ok
	rule.mode == "Write-bounded"
	to_number(input.args.amount) <= rule.maxAmount
}
decision := {"effect": "deny", "reason": "over bound"} if {
	grant_ok
	rule.mode == "Write-bounded"
	to_number(input.args.amount) > rule.maxAmount
}
`;
