/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { errorBody, type ServerParams } from '@core/kernel/server-message';

/**
 * Upload integrity check (pure, unit-tested). A raw upload's received byte length MUST
 * match the client-declared Content-Length; a short read means the stream was truncated
 * or aborted (e.g. an ingress timeout), which would otherwise be stored as a silently
 * corrupt file. Returns a friendly, retryable error string, or null when the body is
 * whole (or no Content-Length was declared, so there is nothing to compare against).
 */
export function truncationError(received: number, declaredHeader: string | null): string | null {
  const declared = Number(declaredHeader);
  if (!Number.isFinite(declared) || declared <= 0) return null; // nothing to compare
  if (received === declared) return null;
  return `upload incomplete — received ${received} of ${declared} bytes; please retry`;
}

/**
 * The JSON error body of that refusal (i18n wave 4): the unchanged English `error` plus the
 * `server.upload.incomplete` code the UI renders in the person's language. Null when the body is whole.
 */
export function truncationErrorBody(received: number, declaredHeader: string | null): { error: string; code?: string; params?: ServerParams } | null {
  const english = truncationError(received, declaredHeader);
  return english ? errorBody(english, 'upload.incomplete', { received, declared: Number(declaredHeader) }) : null;
}
