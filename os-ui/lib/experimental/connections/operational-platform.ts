/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE, client-safe operational-platform identity (no secrets, no server imports) — the
 * one place the api-batch platform label and the template↔platform map live, shared by the
 * server registry (`operational-registry.ts`), the client cursor-honesty (`operational-cursor.ts`),
 * and the UI. Kept separate from the server registry so the UI can import it without
 * dragging the slice runners / connector clients into the client bundle.
 */
import type { ConnectionTemplateKey } from './schema.ts';

/** The api-batch platform label the sync executor dispatches on (its slice runner).
 *  'odata' backs BOTH `sap-odata` and `odata-v4` (one generic core); 'workday' backs the
 *  RaaS report-as-entity source. */
export type OperationalPlatform = 'salesforce' | 'kajabi' | 'odata' | 'workday';

/** template → operational platform. Absent ⇒ not an operational api-batch source. */
const TEMPLATE_PLATFORM: Partial<Record<ConnectionTemplateKey, OperationalPlatform>> = {
  'salesforce-api': 'salesforce',
  'kajabi-api': 'kajabi',
  'sap-odata': 'odata',
  'odata-v4': 'odata',
  'workday-raas': 'workday',
};

/** The operational platform for a template, or undefined when it is not operational. */
export function operationalPlatformFor(template: ConnectionTemplateKey): OperationalPlatform | undefined {
  return TEMPLATE_PLATFORM[template];
}

/** True when a template is an operational api-batch source. */
export function isOperationalTemplate(template: ConnectionTemplateKey): boolean {
  return TEMPLATE_PLATFORM[template] !== undefined;
}

/** Every operational template key (for widening the exposed-tables / expose gates). */
export function operationalTemplates(): ConnectionTemplateKey[] {
  return Object.keys(TEMPLATE_PLATFORM) as ConnectionTemplateKey[];
}

/**
 * The ADOPTION GATE for a template (M1): an exposure/connection may be adopted as a
 * governed dataset when EITHER the operator enabled external-warehouse connectors (the
 * federation flag) OR the source is an operational api-batch connector — those are
 * user-facing without the flag, so requiring it wrongly blocked adopting operational
 * exposures (and returned a misleading "external connectors are not enabled" 403). Pure +
 * client-safe; both the browse route and the adopt seam key on it so they can't drift.
 */
export function adoptionEnabledFor(template: ConnectionTemplateKey, externalConnectorsEnabled: boolean): boolean {
  return externalConnectorsEnabled || isOperationalTemplate(template);
}

/**
 * CAPABILITY FLAG — the templates that carry a REGISTERED action-tool set (the entity-
 * generic `sf_*` tools + the four-layer intersection machinery). Today that is ONLY
 * `salesforce-api`; Kajabi/SAP-OData/Workday are operational SYNC sources with NO action
 * tools, so their expose panel must NOT offer action-arming toggles (there is nothing to
 * arm — the decision doc). Both the client (ExposePanel) and the server (sanitizeActions)
 * key on this so the two can never drift. Pure + client-safe.
 */
const ACTION_TOOL_TEMPLATES = new Set<ConnectionTemplateKey>(['salesforce-api']);

/** True when a template has a registered action-tool set (arming UI + action grants). */
export function templateHasActionTools(template: ConnectionTemplateKey): boolean {
  return ACTION_TOOL_TEMPLATES.has(template);
}
