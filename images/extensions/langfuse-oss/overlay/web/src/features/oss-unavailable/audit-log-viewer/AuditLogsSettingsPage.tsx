// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Audit-log viewer (Enterprise Edition): not in this build.
import { UnavailableNotice } from "@/src/features/oss-unavailable/UnavailableNotice";

export function AuditLogsSettingsPage(_props: { projectId: string }) {
  return <UnavailableNotice title="Audit logs" />;
}
