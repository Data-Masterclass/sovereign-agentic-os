// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Multi-tenant SSO (Enterprise Edition): not in this build. No domain has a per-tenant SSO provider and
// no dynamic provider is loaded; the SSO providers configured by environment variables (Langfuse MIT code,
// server/auth.ts) are unaffected.
import type { Provider } from "next-auth/providers/index";

export const findMultiTenantSsoConfig = async (_args: {
  providerId: string;
}): Promise<
  | { isMultiTenantSsoProvider: true; domain: string }
  | { isMultiTenantSsoProvider: false; domain?: undefined }
> => ({ isMultiTenantSsoProvider: false });

export async function getSsoAuthProviderIdForDomain(
  _domain: string,
): Promise<string | null> {
  return null;
}

export async function isAnySsoConfigured(): Promise<boolean> {
  return false;
}

export async function loadSsoProviders(): Promise<Provider[]> {
  return [];
}
