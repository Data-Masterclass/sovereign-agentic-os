// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Shown by Langfuse's MIT pages when the plan lacks an entitlement. There is no plan to upgrade to in this
// build, so it says the feature is unavailable.
import { UnavailableNotice } from "@/src/features/oss-unavailable/UnavailableNotice";

export const SupportOrUpgradePage = () => (
  <div className="p-6">
    <UnavailableNotice title="Not available" />
  </div>
);
