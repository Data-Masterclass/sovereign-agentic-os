// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for a module of the Langfuse Enterprise Edition, which this build does not contain. Only the
// exported names and parameter lists match what Langfuse's MIT code imports; every handler answers that
// the feature is unavailable.

import type { NextApiRequest, NextApiResponse } from "next";
import { idFromQuery, respondUnavailable } from "@/src/features/oss-unavailable/unavailable";

export async function handleDeleteApiKey(
  _req: NextApiRequest,
  res: NextApiResponse,
  _projectId: string,
  _apiKeyId: string,
  _orgId: string,
): Promise<void> {
  respondUnavailable(res);
}

export const validateQueryParams = (
  query: NextApiRequest["query"],
): { projectId: string; apiKeyId: string } | null => {
  const projectId = idFromQuery(query, "projectId");
  const apiKeyId = idFromQuery(query, "apiKeyId");
  return projectId && apiKeyId ? { projectId, apiKeyId } : null;
};
