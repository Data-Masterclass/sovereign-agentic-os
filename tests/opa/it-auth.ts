/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The OPA API tokens of the chart's OPA container (tests/opa/run-chart-opa.py writes them to
 * OPA_IT_TOKENS_FILE). Importing this module makes the OS code under test present the writer
 * token, exactly as os-ui does in the cluster (OPA_TOKEN from the Secret `opa-tokens`).
 */
import { readFileSync } from 'node:fs';

const file = process.env.OPA_IT_TOKENS_FILE;
export const tokens: { writer?: string; reader?: string } = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (tokens.writer) process.env.OPA_TOKEN = tokens.writer;

/** fetch() as the OS reconciler (writer token), for the tests' own direct OPA reads and writes. */
export function opaFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...((init.headers ?? {}) as Record<string, string>) };
  if (tokens.writer) headers.authorization = `Bearer ${tokens.writer}`;
  return fetch(url, { ...init, headers });
}
