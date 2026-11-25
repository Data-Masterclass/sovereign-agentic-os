// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// langfuse-oss stub: original code, see docs/components/langfuse-oss.md in the Sovereign Agentic OS repository.
// Stands in for the Enterprise Edition's admin-API authentication. This build has no admin API: every
// check refuses, so the routes that use it (/api/admin/*, tRPC adminProcedure) answer 403.
import type { NextApiRequest, NextApiResponse } from "next";
import {
  OSS_UNAVAILABLE_MESSAGE,
  respondUnavailable,
} from "@/src/features/oss-unavailable/unavailable";

type AdminAuthOptions = { isAllowedOnLangfuseCloud?: boolean };
type AdminAuthResult =
  | { isAuthorized: true }
  | { isAuthorized: false; error: string };

export class AdminApiAuthService {
  static verifyAdminAuthFromAuthString = (
    _authString: string,
    _options: AdminAuthOptions = {},
  ): AdminAuthResult => ({ isAuthorized: false, error: OSS_UNAVAILABLE_MESSAGE });

  public static handleAdminAuth(
    _req: NextApiRequest,
    res: NextApiResponse,
    _options: AdminAuthOptions = {},
  ): boolean {
    respondUnavailable(res);
    return false;
  }
}
