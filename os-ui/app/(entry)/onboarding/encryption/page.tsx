/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import { PasswordField, ProviderForm, RecoveryChoiceStep, useKeys } from '@tabs/admin/ui/EncryptionKeys';

/**
 * INSTALL WIZARD — step 2 of first-run setup (after the bootstrap admin set a real account):
 * "Where should encryption keys live?". Default: built into the OS; or a key provider (STACKIT KMS)
 * with its credentials and a "Test connection". Then the RECOVERY CHOICE: "No recovery key" (one
 * acknowledgement) or "Recovery key" (saved offline). No recovery key is set up automatically, but the
 * choice stays "not made" until an admin confirms one. Same API and the same re-auth + audit as
 * Platform → Encryption keys. It can be skipped — the built-in key works at once — but Monitoring
 * warns, and a production release stops, until the recovery choice is made.
 *
 * I18N: converted (wave 2) — this page's strings from the `home` namespace (`home.encryption.*`). The key forms
 * themselves come from Platform (`tabs/admin/ui/EncryptionKeys`) and convert with the `admin` namespace.
 */
export default function EncryptionSetupPage() {
  const t = useTranslations('home');
  const { state, error, load } = useKeys();
  const [choice, setChoice] = useState<'builtin' | 'provider'>('builtin');
  const [password, setPassword] = useState('');
  const v = state?.view;
  const done = Boolean(v && v.recoveryChoice?.choice !== 'unset');

  return (
    <div className="content" style={{ maxWidth: 720, margin: '40px auto' }}>
      <div className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>{t('encryption.step')}</div>
      <h1 style={{ margin: '6px 0 4px' }}>{t('encryption.title')}</h1>
      <p className="muted">{t('encryption.intro')}</p>
      {error ? <div className="error">{error}</div> : null}
      {!state ? <div className="stub-page">{t('encryption.loading')}</div> : !state.managed || !v ? (
        <div className="card"><p className="muted">{state.note}</p><a className="btn" href="/">{t('encryption.continue')}</a></div>
      ) : (
        <>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
            <button className={`btn ${choice === 'builtin' ? '' : 'ghost'}`} onClick={() => setChoice('builtin')}>{t('encryption.builtin')}</button>
            <button className={`btn ${choice === 'provider' ? '' : 'ghost'}`} onClick={() => setChoice('provider')}>{t('encryption.provider')}</button>
          </div>
          <div className="card">
            <PasswordField value={password} onChange={setPassword} />
            {choice === 'builtin' ? (
              <>
                <p className="muted" style={{ fontSize: 13 }}>{t('encryption.builtinNote')}</p>
                <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
              </>
            ) : (
              <>
                <ProviderForm providers={state.providers} current={v.provider.id} password={password} onChanged={() => load(true)} />
                <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>{t('encryption.providerNote')}</p>
                <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
              </>
            )}
          </div>
          <div className="row" style={{ gap: 12, marginTop: 16, alignItems: 'center' }}>
            <a className="btn" href="/">{done ? t('encryption.finish') : t('encryption.skip')}</a>
            {!done ? <span className="muted" style={{ fontSize: 12 }}>{t('encryption.skipNote')}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
