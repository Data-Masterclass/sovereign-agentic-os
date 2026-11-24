/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { PasswordField, ProviderForm, RecoveryKeyStep, useKeys } from '@tabs/admin/ui/EncryptionKeys';

/**
 * INSTALL WIZARD — step 2 of first-run setup (after the bootstrap admin set a real account):
 * "Where should encryption keys live?". Default: built into the OS + a recovery key the installer
 * saves offline; or a key provider (STACKIT KMS) with its credentials and a "Test connection".
 * Same API and the same re-auth + audit as Platform → Encryption keys. It can be skipped — the
 * built-in key works at once — but Monitoring warns until a recovery key is confirmed.
 */
export default function EncryptionSetupPage() {
  const { state, error, load } = useKeys();
  const [choice, setChoice] = useState<'builtin' | 'provider'>('builtin');
  const [password, setPassword] = useState('');
  const v = state?.view;
  const done = v?.recovery.state === 'confirmed' || (v?.provider.id && v.provider.id !== 'builtin');

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
            <button className={`btn ${choice === 'builtin' ? '' : 'ghost'}`} onClick={() => setChoice('builtin')}>Built into the OS + recovery key (recommended)</button>
            <button className={`btn ${choice === 'provider' ? '' : 'ghost'}`} onClick={() => setChoice('provider')}>A key management service (STACKIT KMS)</button>
          </div>
          <div className="card">
            <PasswordField value={password} onChange={setPassword} />
            {choice === 'builtin' ? (
              <>
                <p className="muted" style={{ fontSize: 13 }}>
                  The OS keeps the master key in the cluster, never in a backup. Save the recovery key below: after a
                  restore or a rebuild it is the only way to open the stored credentials again.
                </p>
                <RecoveryKeyStep password={password} state={v.recovery.state} onChanged={() => load()} />
              </>
            ) : (
              <>
                <ProviderForm providers={state.providers} current={v.provider.id} password={password} onChanged={() => load(true)} />
                <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>A recovery key is still worth saving — it opens the credentials even if the KMS key or its access is lost.</p>
                <RecoveryKeyStep password={password} state={v.recovery.state} onChanged={() => load()} />
              </>
            )}
          </div>
          <div className="row" style={{ gap: 12, marginTop: 16, alignItems: 'center' }}>
            <a className="btn" href="/">{done ? 'Finish setup' : 'Skip for now'}</a>
            {!done ? <span className="muted" style={{ fontSize: 12 }}>Skipping keeps the built-in key; Monitoring warns until a recovery key is saved.</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
