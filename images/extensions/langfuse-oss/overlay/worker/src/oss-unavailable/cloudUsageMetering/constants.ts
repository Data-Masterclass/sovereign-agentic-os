// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for a worker job of the Langfuse Enterprise Edition, which this build does not contain. The
// image sets the queue consumer off (Dockerfile ENV); if it is switched on anyway, the job fails loudly.
// Names used by Langfuse's MIT queue code (worker/src/queues/cloudUsageMeteringQueue.ts) when it records
// the cron job; that code runs only with the consumer switched on. The state values are lower case, as the
// stored job states are (constants only; there is no logic here).
export const cloudUsageMeteringDbCronJobName = "cloud_usage_metering";

export enum CloudUsageMeteringDbCronJobStates {
  Queued = "queued",
  Processing = "processing",
}
