/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalNotice,
  canApproveInline,
  policiesHref,
  targetScopeWord,
  POLICIES_PATH,
  type FiledApproval,
  type NoticeUser,
} from './approval-notice.ts';

// A files → Domain promotion request (domain-scoped, domain_admin approves).
const filesReq: FiledApproval = {
  id: 'apr_files1',
  domain: 'sales',
  approverRole: 'domain_admin',
  scope: 'domain',
};
// A certify → Company request (tenant-scoped, admin approves).
const certifyReq: FiledApproval = {
  id: 'apr_cert1',
  domain: 'sales',
  approverRole: 'admin',
  scope: 'tenant',
};

const creator: NoticeUser = { id: 'u_creator', role: 'creator', domains: ['sales'] };
const salesAdmin: NoticeUser = { id: 'u_da', role: 'domain_admin', domains: ['sales'] };
const otherAdmin: NoticeUser = { id: 'u_da2', role: 'domain_admin', domains: ['ops'] };
const platformAdmin: NoticeUser = { id: 'u_admin', role: 'admin', domains: ['sales'] };

test('files-approval notice carries the Policies & Approvals link (focused on the request)', () => {
  const n = approvalNotice(filesReq, 'file', creator);
  assert.match(n.message, /Request filed/);
  assert.match(n.message, /Policies & Approvals/);
  assert.match(n.message, /Domain/); // promotion → Domain wording
  assert.equal(n.policiesHref, `${POLICIES_PATH}?focus=apr_files1`);
  assert.equal(n.requestId, 'apr_files1');
});

test('admin approver of the target domain is offered inline Approve now', () => {
  assert.equal(canApproveInline(salesAdmin, filesReq), true);
  assert.equal(approvalNotice(filesReq, 'file', salesAdmin).canApproveInline, true);
});

test('platform admin can inline-approve any domain item and any certification', () => {
  assert.equal(canApproveInline(platformAdmin, filesReq), true);
  assert.equal(canApproveInline(platformAdmin, certifyReq), true);
});

test('non-approver (creator) is NOT offered inline Approve now', () => {
  assert.equal(canApproveInline(creator, filesReq), false);
  assert.equal(approvalNotice(filesReq, 'file', creator).canApproveInline, false);
});

test('domain_admin of ANOTHER domain is NOT offered inline approve (fail-closed on scope)', () => {
  assert.equal(canApproveInline(otherAdmin, filesReq), false);
});

test('a domain_admin cannot inline-approve a tenant-scoped certification (needs admin)', () => {
  assert.equal(canApproveInline(salesAdmin, certifyReq), false);
});

test('missing user fails closed (no inline approve)', () => {
  assert.equal(canApproveInline(null, filesReq), false);
  assert.equal(canApproveInline(undefined, filesReq), false);
});

test('own-scope items are never inline-approvable (requester is not an approver)', () => {
  const own: FiledApproval = { ...filesReq, scope: 'own' };
  assert.equal(canApproveInline(salesAdmin, own), false);
  assert.equal(canApproveInline(platformAdmin, own), false);
});

test('targetScopeWord: tenant/admin → Company, else Domain', () => {
  assert.equal(targetScopeWord(certifyReq), 'Company');
  assert.equal(targetScopeWord(filesReq), 'Domain');
});

test('certification notice says awaiting approval to Company', () => {
  const n = approvalNotice(certifyReq, 'dataset', salesAdmin);
  assert.match(n.message, /Company/);
});

test('policiesHref: bare path without id, focus param with id', () => {
  assert.equal(policiesHref(), POLICIES_PATH);
  assert.equal(policiesHref('apr_x'), `${POLICIES_PATH}?focus=apr_x`);
});
