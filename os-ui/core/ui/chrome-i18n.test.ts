/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The shared core chrome in seven languages (i18n wave 4) — scope words, lifecycle copy, badges,
 *             go-live, the stage rail and Choose Context
 * USER STORY: As a maintainer I want proof that every key-returning twin renders, in English, exactly the text its
 *             English helper returns, and that every locale has every key it can return — so converting the chrome
 *             changed nothing for an English reader and no language falls back.
 * ARCHITECTURE: Renders the twins through `core/testing/catalog-text.ts` (the next-intl ICU engine over the real
 *   `messages/<locale>/common.json`) and compares with the unchanged English helpers. Pure modules only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LOCALES, catalogText } from '@core/testing/catalog-text';
import {
  SCOPE_GROUPS, scopeLabel, scopeLabelMessage, visibilityLabel, visibilityLabelMessage,
  promoteVerb, promoteVerbMessage, demoteVerb, demoteVerbMessage, type ScopeKey,
} from '@core/kernel/scopes';
import {
  archiveCopy, archiveCopyMessage, deleteCopy, deleteCopyMessage, archiveFolderCopy, archiveFolderCopyMessage,
  deleteFolderCopy, deleteFolderCopyMessage, restoreVersionCopy, restoreVersionCopyMessage, renderConfirmCopy,
  type ArtifactKind,
} from '@core/kernel/lifecycle';
import { grantedSummary, grantedSummaryMessage } from '@core/kernel/choose-context';
import { stageStatuses, type StageDef } from '@core/kernel/stages';
import {
  audienceBadge, audienceBadgeMessage, lifecycleBadge, lifecycleBadgeMessage, renderBadge,
} from '@core/ui/lifecycle/badges';
import {
  goLiveButtonLabel, goLiveButtonLabelMessage, goLiveDialogCopy, goLiveDialogCopyIn, retireDialogCopy, retireDialogCopyIn,
  type GoLivePreviewDto,
} from '@core/ui/lifecycle/go-live-client';
import { nextHintMessage, stageLabelMessage, stageStateWord, stepAriaMessage } from '@core/ui/core/stage-shell-labels';
import type { LifecycleWord } from '@core/kernel/object-lifecycle';

type Msg = { key: string; args?: Record<string, string | number> };
const en = (m: Msg | string) => catalogText('common', m);
/** Every locale renders the message (a missing key or a bad ICU string throws). */
const everyLocale = (m: Msg | string) => {
  for (const l of CATALOG_LOCALES) assert.ok(catalogText('common', m, l).length > 0, `${l}: ${typeof m === 'string' ? m : m.key}`);
};

const SCOPES = SCOPE_GROUPS.map((g) => g.key) as ScopeKey[];
const KINDS: ArtifactKind[] = ['dataset', 'file', 'app', 'agent', 'dashboard', 'metric', 'connection', 'knowledge'];

test('scope labels: English unchanged with and without a kind; every locale has every key', () => {
  for (const k of SCOPES) {
    for (const kind of [undefined, 'Data', 'Agents']) {
      const m = scopeLabelMessage(k, kind);
      assert.equal(en(m), scopeLabel(k, kind));
      assert.equal(en(m), SCOPE_GROUPS.find((g) => g.key === k)!.label(kind));
      everyLocale(m);
    }
  }
  for (const v of ['Personal', 'Shared', 'Certified', 'Marketplace', 'weird']) {
    assert.equal(en(visibilityLabelMessage(v)), visibilityLabel(v));
    assert.equal(en(visibilityLabelMessage(v, 'Software')), visibilityLabel(v, 'Software'));
  }
});

test('scope verbs: promote / propose / certify / revoke / unshare read exactly as before', () => {
  for (const v of ['Personal', 'Shared']) {
    for (const propose of [false, true]) {
      const m = promoteVerbMessage(v, { propose });
      assert.equal(en(m), promoteVerb(v, { propose }));
      everyLocale(m);
    }
  }
  for (const v of ['Personal', 'Shared', 'Certified', 'Marketplace']) {
    const m = demoteVerbMessage(v);
    assert.equal(m ? en(m) : '', demoteVerb(v));
    if (m) everyLocale(m);
  }
});

test('lifecycle confirms: archive, delete per kind (personal + shared), folders, restore-version unchanged', () => {
  const check = (m: Parameters<typeof renderConfirmCopy>[0], english: ReturnType<typeof archiveCopy>) => {
    assert.deepEqual(renderConfirmCopy(m, en), english);
    for (const l of CATALOG_LOCALES) renderConfirmCopy(m, (x) => catalogText('common', x, l));
  };
  check(archiveCopyMessage('Q3 sales'), archiveCopy('Q3 sales'));
  for (const kind of KINDS) {
    for (const vis of ['personal', 'shared', 'certified']) check(deleteCopyMessage(kind, 'Orders', vis), deleteCopy(kind, 'Orders', vis));
  }
  for (const n of [0, 1, 2, 17]) {
    check(archiveFolderCopyMessage('Finance', n), archiveFolderCopy('Finance', n));
    check(deleteFolderCopyMessage('Finance', n), deleteFolderCopy('Finance', n));
  }
  check(restoreVersionCopyMessage('Orders', 3), restoreVersionCopy('Orders', 3));
  check(restoreVersionCopyMessage('Orders', 12345), restoreVersionCopy('Orders', 12345));
});

test('badges: lifecycle and audience badges read exactly as before', () => {
  const lifecycles = [{ draft: 'aaaaaaa1' }, { draft: 'aaaaaaa1', testing: 'aaaaaaa1' }, { draft: 'bbbbbbb2', live: 'bbbbbbb2' },
    { draft: 'ccccccc3', live: 'dddddddd' }];
  for (const l of lifecycles) {
    assert.deepEqual(renderBadge(lifecycleBadgeMessage(l), en), lifecycleBadge(l));
    for (const loc of CATALOG_LOCALES) renderBadge(lifecycleBadgeMessage(l), (m) => catalogText('common', m, loc));
  }
  for (const tier of ['Personal', 'personal', 'Shared', 'asset', 'Certified', 'Marketplace', 'product', '']) {
    assert.deepEqual(renderBadge(audienceBadgeMessage(tier), en), audienceBadge(tier));
    for (const loc of CATALOG_LOCALES) renderBadge(audienceBadgeMessage(tier), (m) => catalogText('common', m, loc));
  }
});

test('go live: button label, blocked dialog and retire dialog unchanged in English', () => {
  for (const word of ['draft', 'testing', 'live'] as LifecycleWord[]) {
    for (const u of [false, true]) {
      assert.equal(en(goLiveButtonLabelMessage(word, u)), goLiveButtonLabel(word, u));
      everyLocale(goLiveButtonLabelMessage(word, u));
    }
  }
  const preview = (blocked: string | null): GoLivePreviewDto => ({
    object: { kind: 'dashboard', id: 'd1', name: 'Orders revenue', head: 'abc', tier: 'Personal' },
    ref: 'abc', dependencies: [], blocked,
    confirm: { title: 'Go live?', body: 'Server sentence.', confirmLabel: 'Go live' },
  });
  for (const b of [null, 'cannot go live: metric “m” is Draft, not Live.']) {
    assert.deepEqual(goLiveDialogCopyIn(preview(b), en), goLiveDialogCopy(preview(b)));
    for (const l of CATALOG_LOCALES) goLiveDialogCopyIn(preview(b), (m) => catalogText('common', m, l));
  }
  assert.deepEqual(retireDialogCopyIn('Orders', 'dashboard', en), retireDialogCopy('Orders', 'dashboard'));
  for (const l of CATALOG_LOCALES) retireDialogCopyIn('Orders', 'dashboard', (m) => catalogText('common', m, l));
});

test('stage rail: tooltip and aria label equal the kernel English; next hint reads as before', () => {
  type Ctx = { a: boolean; problem: boolean; pending: boolean };
  const stages: StageDef<'one' | 'two' | 'three', Ctx>[] = [
    { id: 'one', title: 'Define', completed: (c) => c.a },
    { id: 'two', title: 'Grant', problem: (c) => (c.problem ? { tone: 'error', label: 'last build failed' } : null), pending: (c) => (c.pending ? 'nothing granted yet' : '') },
    { id: 'three', title: 'Build' },
  ];
  for (const ctx of [{ a: true, problem: false, pending: false }, { a: false, problem: true, pending: true }, { a: true, problem: false, pending: true }]) {
    for (const st of stageStatuses(stages, { current: 'one' }, ctx)) {
      const label = en(stageLabelMessage(st.title, en(stageStateWord(st.state))));
      assert.equal(label, st.label);
      assert.equal(en(stepAriaMessage(st.index, label)), `Step ${st.index + 1} — ${st.label}`);
      for (const l of CATALOG_LOCALES) catalogText('common', stepAriaMessage(st.index, catalogText('common', stageLabelMessage(st.title, catalogText('common', stageStateWord(st.state), l)), l)), l);
    }
  }
  assert.equal(en(nextHintMessage(true, 'Build', 'Grant')), 'Continue to Build');
  assert.equal(en(nextHintMessage(false, 'Build', 'Grant')), 'Finish Grant first');
  everyLocale({ key: 'stage.railAria' });
  assert.equal(en({ key: 'stage.railAria' }), 'Stages');
});

test('choose context: granted summary unchanged; the shell words exist in every locale', () => {
  for (const n of [0, 1, 2, 5, 22]) {
    assert.equal(en(grantedSummaryMessage(n)), grantedSummary(n));
    everyLocale(grantedSummaryMessage(n));
    assert.equal(en({ key: 'chooseContext.grantedBadge', args: { count: n } }), `${n} granted`);
    everyLocale({ key: 'chooseContext.grantedBadge', args: { count: n } });
  }
  for (const k of ['addExisting', 'loading', 'createNew']) everyLocale({ key: `chooseContext.${k}` });
});

test('component-only words (lifecycle buttons, versions, promote/demote, folders) exist in every locale', () => {
  const keys = [
    'lifecycle.actionFailed', 'lifecycle.restore', 'lifecycle.delete', 'lifecycle.deleteHint', 'lifecycle.archive', 'lifecycle.archiveHint',
    'lifecycle.versionHistory', 'lifecycle.hideHistory', 'lifecycle.versions.loadFailed', 'lifecycle.versions.restoreFailed',
    'lifecycle.versions.unavailable', 'lifecycle.versions.loading', 'lifecycle.versions.empty', 'lifecycle.versions.current',
    'lifecycle.versions.restore', 'lifecycle.promote.certifyLabel', 'lifecycle.promote.failed', 'lifecycle.promote.awaitingHint',
    'lifecycle.promote.requested', 'lifecycle.promote.approvalsLink', 'lifecycle.demote.failed', 'lifecycle.goLive.unavailable',
    'folders.newFolderPrompt', 'folders.collapse', 'folders.expand', 'folders.emptyHint', 'folders.newSubfolder', 'folders.moveFolder',
    'folders.rename', 'folders.move', 'folders.archive', 'folders.restore', 'folders.deletePermanently', 'folders.newFolderHere',
    'folders.newFolder', 'folders.newFolderAtRoot', 'folders.root', 'folders.none', 'folders.myFolders', 'folders.domainFolders',
    'folders.moveHere', 'folders.moveToFolder', 'folders.close',
  ];
  for (const k of keys) everyLocale({ key: k });
  const withArgs: Msg[] = [
    { key: 'lifecycle.versions.number', args: { version: '7' } },
    { key: 'lifecycle.promote.certifyTitle', args: { kind: 'metric' } }, { key: 'lifecycle.promote.certifyBody', args: { kind: 'metric' } },
    { key: 'lifecycle.promote.requestFiled', args: { kind: 'metric' } }, { key: 'lifecycle.promote.certifiedDone', args: { label: 'Certify to Company' } },
    { key: 'lifecycle.promote.promotedToDomain', args: { kind: 'metric' } },
    { key: 'lifecycle.demote.revokeTitle', args: { kind: 'metric' } }, { key: 'lifecycle.demote.unshareTitle', args: { kind: 'metric' } },
    { key: 'lifecycle.demote.revokeBody', args: { kind: 'metric' } }, { key: 'lifecycle.demote.unshareBody', args: { kind: 'metric' } },
    { key: 'lifecycle.demote.revoked', args: { kind: 'metric' } }, { key: 'lifecycle.demote.unshared', args: { kind: 'metric' } },
    { key: 'folders.selectFolderAria', args: { name: 'x' } }, { key: 'folders.selectItemAria', args: { name: 'x' } },
    { key: 'folders.grantAllAria', args: { label: 'My folders' } }, { key: 'folders.allRoot', args: { label: 'My folders' } },
  ];
  for (const m of withArgs) everyLocale(m);
  // The English the components showed before conversion.
  assert.equal(en(withArgs[0]), 'v7');
  assert.equal(en(withArgs[1]), 'Certify this metric to Company?');
  assert.equal(en(withArgs[3]), 'Request filed — approve this metric in Policies & Approvals.');
  assert.equal(en(withArgs[4]), 'Certify to Company — done');
  assert.equal(en(withArgs[5]), 'metric promoted to Domain');
  assert.equal(en(withArgs[10]), 'metric revoked from Company');
  assert.equal(en(withArgs[11]), 'metric unshared');
  assert.equal(en(withArgs[14]), 'Grant all My folders');
  assert.equal(en(withArgs[15]), 'All My folders');
});
