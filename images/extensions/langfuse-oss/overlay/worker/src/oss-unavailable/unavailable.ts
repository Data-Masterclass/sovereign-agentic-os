// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for a worker job of the Langfuse Enterprise Edition, which this build does not contain. The
// image sets the queue consumer off (Dockerfile ENV); if it is switched on anyway, the job fails loudly.
export const OSS_UNAVAILABLE_MESSAGE =
  "This worker job is not available in this Langfuse build (langfuse-oss is built without the Langfuse Enterprise Edition).";

export class OssUnavailableError extends Error {
  constructor() {
    super(OSS_UNAVAILABLE_MESSAGE);
    this.name = "OssUnavailableError";
  }
}
