// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// In-app AI agent (Enterprise Edition): not in this build. The provider renders its children; the hook
// reports the agent as unavailable.
import type { Dispatch, ReactNode, SetStateAction } from "react";

type InAppAiAgentState = {
  isAvailable: boolean;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  isExpanded: boolean;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
};

const noop = () => {};
const UNAVAILABLE: InAppAiAgentState = {
  isAvailable: false,
  open: false,
  setOpen: noop,
  isExpanded: false,
  setIsExpanded: noop,
};

export function InAppAiAgentProvider({
  children,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return <>{children}</>;
}

export function useInAppAiAgent(): InAppAiAgentState {
  return UNAVAILABLE;
}
