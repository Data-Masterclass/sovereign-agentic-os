// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// UI customization (Enterprise Edition): not in this build, so there is never a customization and every
// caller falls back to Langfuse's defaults. The fields are the ones Langfuse's MIT code reads.
import type { LLMAdapter } from "@langfuse/shared";

export type UiCustomization = {
  hostname?: string;
  documentationHref?: string;
  supportHref?: string;
  feedbackHref?: string;
  logoLightModeHref?: string;
  logoDarkModeHref?: string;
  visibleModules: string[];
  defaultModelAdapter?: keyof typeof LLMAdapter;
  defaultBaseUrlOpenAI?: string;
  defaultBaseUrlAzure?: string;
  defaultBaseUrlAnthropic?: string;
};

export const useUiCustomization = (): UiCustomization | null => null;
