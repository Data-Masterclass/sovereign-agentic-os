/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useToolWindow } from '@/components/ToolWindowProvider';

/**
 * Small client button that opens a registered tool same-origin in the overlay.
 * Lets server components (e.g. the Consoles launchpad) trigger the client-side
 * ToolWindow without becoming client components themselves.
 */
export default function OpenToolButton({
  toolKey,
  title,
  label,
  path,
  className = 'btn ghost',
}: {
  toolKey: string;
  title: string;
  label?: string;
  path?: string;
  className?: string;
}) {
  const { openTool } = useToolWindow();
  return (
    <button type="button" className={className} onClick={() => openTool(toolKey, title, path)}>
      {label ?? `Open ${title}`}
    </button>
  );
}
