// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stripe webhook (Enterprise Edition): not in this build; the route answers 403.
import type { NextRequest } from "next/server";
import { unavailableResponse } from "@/src/features/oss-unavailable/unavailable";

export async function stripeWebhookHandler(_req: NextRequest): Promise<Response> {
  return unavailableResponse();
}
