// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stripe billing (Enterprise Edition): not in this build. Langfuse's MIT code only reaches it when
// isCloudBillingEnabled() is true, which it never is here.
import { OssUnavailableError } from "@/src/features/oss-unavailable/unavailable";

export const createBillingServiceFromContext = (_ctx: unknown) => ({
  cancelImmediatelyAndInvoice: async (_orgId: string): Promise<void> => {
    throw new OssUnavailableError();
  },
});
