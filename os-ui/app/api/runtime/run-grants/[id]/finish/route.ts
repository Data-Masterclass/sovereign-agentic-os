/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    POST /api/runtime/run-grants/<id>/finish — see ../../_handlers.ts (WP-15).
 * USER STORY: As a data owner I want Dagster runs to act as me only inside a checked run grant.
 * ARCHITECTURE: Thin route; the handler holds the checks.
 */
import { finish } from '../../_handlers';

export const dynamic = 'force-dynamic';

export const POST = finish;
