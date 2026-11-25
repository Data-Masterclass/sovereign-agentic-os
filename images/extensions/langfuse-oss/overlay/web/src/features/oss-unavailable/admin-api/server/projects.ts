// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for a module of the Langfuse Enterprise Edition, which this build does not contain. Only the
// exported names and parameter lists match what Langfuse's MIT code imports; every handler answers that
// the feature is unavailable.

import type { NextApiRequest, NextApiResponse } from "next";
import { respondUnavailable } from "@/src/features/oss-unavailable/unavailable";

export async function handleGetProjects(
  _req: NextApiRequest,
  res: NextApiResponse,
  _orgId: string,
): Promise<void> {
  respondUnavailable(res);
}
