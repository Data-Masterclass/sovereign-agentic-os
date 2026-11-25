// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for a worker job of the Langfuse Enterprise Edition, which this build does not contain. The
// image sets the queue consumer off (Dockerfile ENV); if it is switched on anyway, the job fails loudly.
import type { Job } from "bullmq";
import { OssUnavailableError } from "../unavailable";

export const handleCloudSpendAlertJob = async (_job: Job): Promise<never> => {
  throw new OssUnavailableError();
};
