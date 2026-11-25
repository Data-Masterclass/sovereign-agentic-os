// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Multi-tenant SSO configuration (Enterprise Edition): not in this build; answers 403.
import type { NextApiRequest, NextApiResponse } from "next";
import { respondUnavailable } from "@/src/features/oss-unavailable/unavailable";

export async function createNewSsoConfigHandler(
  _req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  respondUnavailable(res);
}
