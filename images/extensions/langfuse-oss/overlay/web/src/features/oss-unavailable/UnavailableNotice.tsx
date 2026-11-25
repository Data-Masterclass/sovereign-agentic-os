// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// What the UI shows where Langfuse would render an Enterprise Edition screen.
import { OSS_UNAVAILABLE_MESSAGE } from "@/src/features/oss-unavailable/unavailable";

export function UnavailableNotice({ title }: { title?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-6 text-sm">
      {title ? <p className="font-medium">{title}</p> : null}
      <p className="text-muted-foreground">{OSS_UNAVAILABLE_MESSAGE}</p>
    </div>
  );
}
