/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from '@/lib/mcp/server';
import { fail, str } from '@/lib/mcp/write-common';
import { config } from '@/lib/core/config';
import { principalFor } from '@/lib/governance/roles';
import { servePredict } from '@/lib/experimental/science/serve';
import type { ChurnFeatures } from '@/lib/experimental/science';

/** #28: extracted from server.ts so it stops statically importing
 *  `@/lib/experimental/science/*` (science tab, non-base). */
export const sciencePredictTools: McpTool[] = [
  {
    name: 'science_predict',
    description:
      'Score a DEPLOYED model through the governed predict door. `model` = the registry model name from list_models (default: churn_model, the seeded slice). Path: the Science golden path (guide: sovereign-os://guide/path/science). Governance: runs AS YOU (principal user:<id>) — tier scope + your OPA `predict` grant (the model OWNER may always score their own model), then a Langfuse trace. 404 when ml.enabled=false; a missing grant → forbidden; a not-yet-deployed model → conflict.',
    minRole: 'creator',
    tab: 'science',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Registry model name to score (see list_models). Default: churn_model.' },
        account: { type: 'string', description: 'Account id to score.' },
        features: { type: 'object', description: "Optional feature overrides (keys = the model spec's feature names)." },
      },
    },
    call: async (user, args) => {
      if (!config.mlEnabled) fail('Science (Layer 4) is off — set ml.enabled=true to enable predict', 404);
      // Run-as-user invariant: score under the CALLER's own identity + domains,
      // never a hardcoded service principal. Their OPA `predict` grant decides.
      const result = await servePredict({
        model: str(args.model) || undefined,
        account: str(args.account) || undefined,
        features: (args.features as Partial<ChurnFeatures>) || undefined,
        principal: principalFor(user),
        domains: user.domains,
        isAgent: false,
        requestedBy: user.id,
      });
      return result.body;
    },
  },
];
