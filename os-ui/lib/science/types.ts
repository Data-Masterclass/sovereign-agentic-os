/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Science (Layer 4 / ML) shared types — PURE types only (no secrets, no server
 * imports) so both client components and server routes can import them. The
 * server logic lives in the `server-only` siblings (`model-service.ts`,
 * `agent-control.ts`, `marketplace.ts`, `adapters.ts`).
 *
 * The spine these types describe is "model-as-service, tier-gated": a deployed
 * KServe model is exposed two ways from ONE endpoint — a governed REST `predict`
 * API (Software apps / external) and a governed `predict` MCP tool (agents) —
 * and WHO may call either is governed by the SAME visibility ladder that governs
 * data, metrics, and every other artifact:
 *
 *   Personal ──(Builder promote)──▶ Domain ──(Admin certify)──▶ Marketplace
 *
 * Promoting / certifying the model AUTOMATICALLY widens who can call its
 * API/MCP via the policy compiler → OPA. There is no separate "publish" step.
 */

/** Model-as-service visibility tier — mirrors the artifact Personal/Shared/Certified ladder. */
export type ModelTier = 'Personal' | 'Domain' | 'Marketplace';

/** MLflow-style registry stage. Go-live = Staging→Production (always a Builder). */
export type ModelStage = 'Staging' | 'Production' | 'Archived';

/** The two front doors a deployed model is exposed through (same endpoint, same governance). */
export type FrontDoor = 'rest' | 'mcp';

/** Marketplace consumption mode the owner sets at certify time, per artifact. */
export type ConsumptionMode = 'read-in-place' | 'fork-allowed';

export type ModelVersion = {
  version: string;
  stage: ModelStage;
  auc: number;
  certified: boolean;
  runId: string;
};

/** A Featureform feature row (offline=Iceberg, online=Valkey) — shared by churn + adapters. */
export type FeatureRow = { name: string; entity: string; offline: string; online: string };

/**
 * A deployed model exposed as a governed service. The `tier` is the security
 * boundary for who may call `predict` (via either front door); `consumptionMode`
 * is only meaningful once `tier==='Marketplace'`.
 */
export type ServiceModel = {
  id: string;
  /** Registry name (the KServe InferenceService + OPA tool identity), e.g. `churn_model`. */
  model: string;
  name: string;
  owner: string; // user id
  domain: string; // owning tenant
  tier: ModelTier;
  stage: ModelStage;
  /** Set when an Admin certifies into the Marketplace. */
  consumptionMode?: ConsumptionMode;
  /** Both front doors are auto-registered at the model's CURRENT tier (no publish step). */
  frontDoors: FrontDoor[];
  versions: ModelVersion[];
  /** Soft-archived (retained, reversible). Archived models drop out of the tab list
   *  until restored; delete is reachable only once archived (the OS-wide lifecycle). */
  archived?: boolean;
};

/** The caller of a `predict` front door — a Software app/external (rest) or an agent (mcp). */
export type Caller = {
  /** OPA principal (LiteLLM key / Ory identity) — e.g. `sales-assistant`, `churn-risk-app`. */
  principal: string;
  /**
   * The caller's domain(s) — DERIVED FROM THE SESSION, never the request body.
   * Tier scope is satisfied when ANY of these is in the model's callable scope,
   * so a user in domain X can never claim domain Y to reach Y's model.
   */
  domains: string[];
  /** True when the caller is an agent (MCP front door); false for a Software app (REST). */
  isAgent: boolean;
};

/**
 * The compiled `predict` policy for one model — the policy-compiler mirror of the
 * OPA data bundle. Authored ONCE (the model's tier + consumption mode) and the
 * shape both front doors evaluate against, so REST and MCP can never drift.
 */
export type CompiledPredictPolicy = {
  model: string;
  tier: ModelTier;
  /** Principals that may always call (the owner's identity + the model's own principal). */
  allowedPrincipals: string[];
  /** Domains whose members may call (widens as the tier rises). */
  allowedDomains: string[];
  /** True at Marketplace tier — any domain may call, subject to its import grant. */
  crossDomain: boolean;
  consumptionMode?: ConsumptionMode;
};

/** Who is acting on a lifecycle transition (promote / go-live / certify). */
export type Actor = {
  id: string;
  role: 'user' | 'builder' | 'domain_admin' | 'admin';
  domains: string[];
  /** Hard invariant: an agent actor can NEVER certify, go-live, or self-promote. */
  isAgent: boolean;
};
