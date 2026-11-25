// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// In-app AI agent endpoint (Enterprise Edition): not in this build; answers 403.
import { unavailableResponse } from "@/src/features/oss-unavailable/unavailable";

export default async function handler(_request: Request): Promise<Response> {
  return unavailableResponse();
}
