// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// The one answer every stub of this directory gives: the feature belongs to the Langfuse Enterprise
// Edition, which this build does not contain.
import type { NextApiRequest, NextApiResponse } from "next";

export const OSS_UNAVAILABLE_MESSAGE =
  "This feature is not available in this Langfuse build (langfuse-oss is built without the Langfuse Enterprise Edition).";

/** Pages-router API handlers: 403 with the message, in both keys Langfuse's API errors use. */
export function respondUnavailable(res: NextApiResponse): void {
  res
    .status(403)
    .json({ message: OSS_UNAVAILABLE_MESSAGE, error: OSS_UNAVAILABLE_MESSAGE });
}

/** App-router route handlers. */
export function unavailableResponse(): Response {
  return Response.json(
    { message: OSS_UNAVAILABLE_MESSAGE, error: OSS_UNAVAILABLE_MESSAGE },
    { status: 403 },
  );
}

export class OssUnavailableError extends Error {
  constructor() {
    super(OSS_UNAVAILABLE_MESSAGE);
    this.name = "OssUnavailableError";
  }
}

/** A single non-empty string query parameter, or null. */
export function idFromQuery(
  query: NextApiRequest["query"],
  key: string,
): string | null {
  const v = query[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
