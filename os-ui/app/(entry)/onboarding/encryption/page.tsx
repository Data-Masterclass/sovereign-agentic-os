/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { PasswordField, ProviderForm, RecoveryChoiceStep, useKeys } from '@tabs/admin/ui/EncryptionKeys';

/**
 * INSTALL WIZARD — step 2 of first-run setup (after the bootstrap admin set a real account):
 * "Where should encryption keys live?". Default: built into the OS; or a key provider (STACKIT KMS)
 * with its credentials and a "Test connection". Then the RECOVERY CHOICE: "No recovery key" (one
 * acknowledgement) or "Recovery key" (saved offline). No recovery key is set up automatically, but the
 * choice stays "not made" until an admin confirms one. Same API and the same re-auth + audit as
 * Platform → Encryption keys. It can be skipped — the built-in key works at once — but Monitoring
 * warns, and a production release stops, until the recovery choice is made.
 */
export default function EncryptionSetupPage() {
  const { state, error, load } = useKeys();
  const [choice, setChoice] = useState<'builtin' | 'provider'>('builtin');
  const [password, setPassword] = useState('');
  const v = state?.view;
  const done = Boolean(v && v.recoveryChoice?.choice !== 'unset');

  return (
    <div className="content" style={{ maxWidth: 720, margin: '40px auto' }}>
      <div className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>SETUP · STEP 2 OF 2</div>
      <h1 style={{ margin: '6px 0 4px' }}>Where should encryption keys live?</h1>
      <p className="muted">
        Every credential people save on a connection (API tokens, OAuth tokens) is encrypted. Choose who holds
        the master key. You can change this later under Platform → Encryption keys.
      </p>
      {error ? <div className="error">{error}</div> : null}
      {!state ? <div className="stub-page">Loading…</div> : !state.managed || !v ? (
        <div className="card"><p className="muted">{state.note}</p><a className="btn" href="/">Continue</a></div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
            <button className={`btn ${choice === 'builtin' ? '' : 'ghost'}`} onClick={() => setChoice('builtin')}>Built into the OS (recommended)</button>
            <button className={`btn ${choice === 'provider' ? '' : 'ghost'}`} onClick={() => setChoice('provider')}>A key management service (STACKIT KMS)</button>
          </div>
          <div className="card">
            <PasswordField value={password} onChange={setPassword} />
            {choice === 'builtin' ? (
              <>
                <p className="muted" style={{ fontSize: 13 }}>
                  The OS keeps the master key in the cluster, never in a backup. Recovery: without a recovery key, losing the
                  cluster&apos;s key means reconnecting the connections; a recovery key avoids that, but whoever holds it can open them.
                </p>
                <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
              </>
            ) : (
              <>
                <ProviderForm providers={state.providers} current={v.provider.id} password={password} onChanged={() => load(true)} />
                <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Recovery: a recovery key opens the credentials even if the KMS key or its access is lost — or choose none and reconnect in that case.</p>
                <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
              </>
            )}
          </div>
          <div className="row" style={{ gap: 12, marginTop: 16, alignItems: 'center' }}>
            <a className="btn" href="/">{done ? 'Finish setup' : 'Skip for now'}</a>
            {!done ? <span className="muted" style={{ fontSize: 12 }}>Skipping keeps the built-in key; Monitoring warns until the recovery choice is made.</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
