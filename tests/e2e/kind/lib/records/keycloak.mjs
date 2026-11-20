/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Test principals from Keycloak: user tokens and the admin REST calls a journey needs
 * USER STORY: As a journey I want u123, u999, the domain admin A, builder B, admin C and viewers
 *             V/W to be real Keycloak users with real tokens, so identity is never simulated.
 * ARCHITECTURE:
 *   - Token: OIDC password grant on realm E2E_KEYCLOAK_REALM for the harness's test client
 *     (direct access grants enabled for test users only). Admin: Admin REST
 *     PUT /admin/realms/<realm>/users/<id> {enabled:false}.
 *     Docs: https://www.keycloak.org/docs-api/latest/rest-api/index.html
 *   - Keycloak arrives with WP-38. Until then the Service is missing and every principal is red.
 */
import { baseUrl } from '../endpoints.mjs';
import { request } from '../http.mjs';
import { HopError } from '../hop.mjs';

const REALM = process.env.E2E_KEYCLOAK_REALM ?? 'sovereign-os';
const CLIENT = process.env.E2E_KEYCLOAK_CLIENT ?? 'e2e-harness';
const PASSWORD = process.env.E2E_TEST_USER_PASSWORD ?? 'e2e-test-password';
const tokens = new Map();

async function kc() {
  return baseUrl('keycloak').catch((e) => { throw new HopError({ component: 'keycloak', hop: 'realm', reason: `no Keycloak in the install (${e.reason ?? e.message})`, wp: 'WP-38' }); });
}

export async function tokenFor(username, { audience } = {}) {
  const key = `${username}|${audience ?? ''}`;
  if (tokens.has(key)) return tokens.get(key);
  const body = new URLSearchParams({ grant_type: 'password', client_id: CLIENT, username, password: PASSWORD, scope: 'openid' });
  if (audience) body.set('audience', audience);
  const { data } = await request('keycloak', `token for ${username}`, `${await kc()}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  tokens.set(key, data.access_token);
  return data.access_token;
}

export async function setEnabled(username, enabled) {
  const admin = await tokenFor(process.env.E2E_KEYCLOAK_ADMIN ?? 'e2e-realm-admin');
  const base = `${await kc()}/admin/realms/${REALM}`;
  const auth = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
  const { data: users } = await request('keycloak', 'find user', `${base}/users?exact=true&username=${encodeURIComponent(username)}`, { headers: auth });
  if (!users.length) throw new HopError({ component: 'keycloak', hop: 'find user', reason: `no user ${username} in realm ${REALM}` });
  await request('keycloak', 'update user', `${base}/users/${users[0].id}`, { method: 'PUT', headers: auth, body: { enabled } });
  tokens.clear();
}
