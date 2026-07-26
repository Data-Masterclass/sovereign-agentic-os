/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';

/**
 * Service-to-service auth header for the in-cluster data-plane services
 * (query-tool + data-runner). Those services trust the principal/role/domains
 * carried in the request body and are only meant to be called by os-ui; this
 * bearer proves the caller IS os-ui, so network reach alone never equals identity
 * (defense-in-depth behind the NetworkPolicies).
 *
 * When `SERVICE_BEARER_TOKEN` is unset (empty), returns {} — no header is attached
 * and the services skip their check too (fail-open by design; netpol is primary).
 * One shared helper so every caller wires the SAME header the SAME way. Server-only.
 */
export function serviceBearerHeader(): Record<string, string> {
  const token = config.serviceBearerToken;
  return token ? { authorization: `Bearer ${token}` } : {};
}
