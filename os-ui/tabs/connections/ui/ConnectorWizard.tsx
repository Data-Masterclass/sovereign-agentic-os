/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 * I18N:       converted (wave 2) — texts from `connections.wizard.*`. Field labels/help of a warehouse provider and
 *             error text from the API come from the server and are shown as they are.
 */
'use client';

/**
 * <ConnectorWizard /> — the ONE shared stepper both create paths use.
 *
 * One component, one set of governed API calls (POST /api/connections). The steps
 * and fields are DRIVEN by the chosen template's metadata (auth kind + connector
 * kind + warehouse-provider fields) — never hardcoded per platform, so a new
 * template (airflow, …) that the API starts returning flows through
 * automatically.
 *
 *   • Supported-type start — a gallery card was clicked; the wizard opens pre-set to
 *     that template and skips straight to its fields.
 *   • Custom start ("＋ New connector") — the wizard opens on a Choose step so the
 *     builder picks the connector type, then fills its metadata-driven fields. For an
 *     API/MCP connector that means endpoint → auth (vaulted) → optional tools spec.
 *
 * The governed create route only accepts the connectors this deployment actually
 * wires end-to-end (the user-facing templates + warehouse when enabled) — the same
 * gate the previous inline form rode. When the API surfaces more service/API
 * templates, they appear in the picker and their endpoint/auth/tools steps light up
 * on their own, because everything here is metadata-driven.
 *
 * Secrets NEVER touch the record or the browser: the credential is POSTed once to the
 * governed create route, which stores only a reference in Secrets Manager.
 *
 * Visual language: the SimpleBuilder `sb-steps` pill stepper, for OS-wide consistency.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import { fixedEndpointHint, looksLikeEndpoint, ENDPOINT_LOOKS_WRONG_KEY } from '@tabs/connections/ui/shared';

// ---- Shared types (mirror the API payload GovernedConnections already loads) ----

type Template = {
  key: string;
  label: string;
  type: string;
  connector: string;
  auth: 'oauth' | 'service';
  endpointHint: string;
};
type WarehouseField = { key: string; label: string; required: boolean; help?: string; kind?: string };
type WarehouseProviderMeta = {
  platform: string;
  label: string;
  capabilities: { federate: boolean; import: boolean };
  credentialFields: WarehouseField[];
  secretKeys: string[];
  liveVerificationRequired: string[];
};
type WarehouseMeta =
  | { enabled: false }
  | { enabled: true; template: Template; providers: WarehouseProviderMeta[] };

export type WizardData = {
  templates: Template[];
  warehouse?: WarehouseMeta;
  canCreate: boolean;
  canCreatePersonal: boolean;
};

/** How the wizard was opened. `custom` = header button (pick any type). */
export type WizardStart =
  | { mode: 'custom' }
  /**
   * A gallery card was clicked, pre-set to that template. `presetPlatform` — set by a
   * per-platform warehouse card — pins the warehouse provider so the platform-picker
   * defaults to it (Snowflake/BigQuery/…): the builder lands straight on that
   * platform's credential fields.
   */
  | { mode: 'type'; template: string; presetPlatform?: string };

type Conn = { id: string; name: string; visibility: string; secretRef: { name: string; key: string } };

/** The stepper's steps (stable ids; the label is `wizard.steps.<id>`). */
type StepId = 'choose' | 'configure' | 'register' | 'name' | 'connect' | 'endpoint' | 'auth' | 'tools' | 'create' | 'credential';

function warehouseMeta(d: WizardData): (WarehouseMeta & { enabled: true }) | null {
  return d.warehouse?.enabled ? d.warehouse : null;
}

// ---- Component --------------------------------------------------------------

export default function ConnectorWizard({
  data, start, onDone, onCancel,
}: {
  data: WizardData;
  start: WizardStart;
  /** Called after a successful create (parent reloads the connections list). */
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const wh = warehouseMeta(data);
  const custom = start.mode === 'custom';

  // The picker's options: every template the API returned, plus warehouse when enabled.
  const pickable = useMemo(() => {
    const opts = data.templates.map((t) => ({ key: t.key, label: t.label, type: t.type }));
    if (wh) opts.push({ key: 'warehouse', label: wh.template.label, type: wh.template.type });
    return opts;
  }, [data.templates, wh]);

  const initialTemplate = start.mode === 'type'
    ? start.template
    : (pickable[0]?.key ?? '');
  const [template, setTemplate] = useState(initialTemplate);

  const isWarehouse = template === 'warehouse';
  const tpl = isWarehouse
    ? (wh?.template ?? data.templates.find((t) => t.key === template))
    : data.templates.find((t) => t.key === template);
  const isOAuth = !isWarehouse && tpl?.auth === 'oauth';
  const isApiConnector = !isWarehouse && (tpl?.connector === 'api' || tpl?.connector === 'mcp');

  // Shared form state. The endpoint starts PREFILLED from the template's fixed endpoint when
  // it has one (Kajabi → https://api.kajabi.com) — editable, but never an empty box that
  // invites pasting a credential. Generic/placeholder templates start empty (placeholder only).
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState(() => {
    const t = data.templates.find((x) => x.key === initialTemplate);
    return fixedEndpointHint(t?.endpointHint) ?? '';
  });
  const [credential, setCredential] = useState('');
  const [openApiSpec, setOpenApiSpec] = useState('');
  // Non-secret config for the half-wired templates (metadata-driven per template key).
  // These stamp the connection's record so it can actually be used: an Atlassian Basic
  // connection needs the account email to auth; a Workday RaaS connection has no entities
  // until at least one report is registered; OData-OAuth needs the token URL; Airflow
  // needs its auth kind + optional Basic username + trigger allowlist.
  const [airflowAuthType, setAirflowAuthType] = useState<'bearer' | 'basic'>('bearer');
  const [airflowUsername, setAirflowUsername] = useState('');
  const [airflowDagAllowlist, setAirflowDagAllowlist] = useState('');
  const [atlassianAuthKind, setAtlassianAuthKind] = useState<'basic' | 'bearer'>('basic');
  const [atlassianEmail, setAtlassianEmail] = useState('');
  const [odataAuthType, setOdataAuthType] = useState<'basic' | 'oauth-cc'>('basic');
  const [odataTokenUrl, setOdataTokenUrl] = useState('');
  const [workdayReports, setWorkdayReports] = useState<{ path: string; key: string; label: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);

  // Warehouse-specific. A per-platform gallery card passes `presetPlatform`, so the
  // provider dropdown defaults straight to that platform (skipping the generic choice).
  const presetPlatform = start.mode === 'type' ? start.presetPlatform : undefined;
  const [whPlatform, setWhPlatform] = useState(presetPlatform ?? '');
  const [whCatalog, setWhCatalog] = useState('');
  const [whFields, setWhFields] = useState<Record<string, string>>({});
  const whProvider = wh?.providers.find((p) => p.platform === whPlatform) ?? wh?.providers[0];

  // The step list is derived from the chosen template's flavour (metadata-driven).
  const steps = useMemo<StepId[]>(() => {
    const choose: StepId[] = custom ? ['choose'] : [];
    if (isWarehouse) return [...choose, 'configure', 'register'];
    if (isOAuth) return [...choose, 'name', 'connect'];
    if (isApiConnector) return [...choose, 'endpoint', 'auth', 'tools', 'create'];
    return [...choose, 'credential', 'create'];
  }, [custom, isWarehouse, isOAuth, isApiConnector]);
  const last = steps.length - 1;
  // `s` is the position within the flow AFTER the optional Choose step.
  const s = custom ? step - 1 : step;
  const onChoose = custom && step === 0;

  // ---- Governed create (SAME calls the page always made) ----

  async function createWarehouse() {
    if (!name.trim() || !whProvider || creating) return;
    setCreating(true); setMsg('');
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          template: 'warehouse',
          warehouse: { platform: whProvider.platform, catalog: whCatalog.trim(), fields: whFields },
        }),
      });
      const resp = await res.json() as { connection?: Conn; error?: string };
      if (!res.ok || !resp.connection) { setMsg(`✗ ${resp.error ?? t('wizard.whCreateFailed')}`); return; }
      setMsg(`✓ ${t('wizard.whCreated', { name: resp.connection.name, platform: whProvider.label })}`);
      setDone(true);
      onDone();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setCreating(false); }
  }

  async function create() {
    if (!name.trim() || creating) return;
    // Endpoint-shape guard (non-OAuth only): block an obviously-non-URL (a pasted credential)
    // before it reaches the egress path, where the error would echo it back. Server stays authority.
    if (!isOAuth && !looksLikeEndpoint(endpoint)) { setMsg(`✗ ${t(ENDPOINT_LOOKS_WRONG_KEY)}`); return; }
    setCreating(true); setMsg('');
    try {
      const body: Record<string, unknown> = { name, template };
      if (!isOAuth) {
        body.endpoint = endpoint;
        body.credential = credential;
        if (isApiConnector && openApiSpec.trim()) {
          let spec: unknown = openApiSpec.trim();
          try { spec = JSON.parse(openApiSpec.trim()); } catch { /* send raw — backend tolerates */ }
          body.openApiSpec = spec;
        }
      }
      // Attach the non-secret config block for the half-wired templates (secrets stay
      // in the credential field, vaulted server-side).
      if (template === 'airflow') {
        body.airflow = {
          authType: airflowAuthType,
          username: airflowAuthType === 'basic' ? airflowUsername.trim() : undefined,
          dagAllowlist: airflowDagAllowlist.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
        };
      }
      if (template === 'atlassian') {
        body.atlassian = {
          authKind: atlassianAuthKind,
          email: atlassianAuthKind === 'basic' ? atlassianEmail.trim() : undefined,
        };
      }
      if (template === 'sap-odata' || template === 'odata-v4') {
        body.odata = {
          authType: odataAuthType,
          tokenUrl: odataAuthType === 'oauth-cc' ? odataTokenUrl.trim() : undefined,
        };
      }
      if (template === 'workday-raas') {
        body.workday = {
          reports: workdayReports
            .filter((r) => r.path.trim())
            .map((r) => ({ path: r.path.trim(), key: r.key.trim() || undefined, label: r.label.trim() || undefined })),
        };
      }
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resp = await res.json() as { connection?: Conn; error?: string };
      if (!res.ok || !resp.connection) { setMsg(`✗ ${resp.error ?? t('wizard.createFailed')}`); return; }
      const c = resp.connection;
      const ref = `${c.secretRef.name}/${c.secretRef.key}`;
      setMsg(`✓ ${isOAuth ? t('wizard.oauthCreated', { name: c.name, ref }) : t('wizard.created', { name: c.name, ref })}`);
      setDone(true);
      onDone();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setCreating(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 18, borderColor: 'var(--gold-line)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <ol className="sb-steps" aria-label={t('wizard.stepsAria')} style={{ marginBottom: 0 }}>
          {steps.map((id, i) => (
            <li key={id} className={`sb-step${step === i ? ' active' : ''}${step > i || done ? ' done' : ''}`}>
              <button type="button" onClick={() => !done && setStep(i)} disabled={done}>
                <span className="sb-step-n">{step > i || done ? '✓' : i + 1}</span>
                <span className="sb-step-label">{t(`wizard.steps.${id}`)}</span>
              </button>
            </li>
          ))}
        </ol>
        <button className="btn ghost" onClick={onCancel}>{done ? t('wizard.close') : tc('actions.cancel')}</button>
      </div>

      {/* ── CUSTOM: Choose the connector type ── */}
      {onChoose ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            {t('wizard.chooseHint')}
          </p>
          <select
            value={template}
            onChange={(e) => {
              const key = e.target.value;
              setTemplate(key);
              // Re-prefill the endpoint for the newly chosen type (Choose precedes Endpoint,
              // so nothing the user typed is clobbered): fixed hint or empty.
              const t = data.templates.find((x) => x.key === key);
              setEndpoint(fixedEndpointHint(t?.endpointHint) ?? '');
            }}
            style={{ width: '100%' }}
          >
            {pickable.map((o) => <option key={o.key} value={o.key}>{o.label} · {o.type}</option>)}
          </select>
        </>
      ) : null}

      {/* ── WAREHOUSE: platform + catalog + provider fields (from provider metadata) ── */}
      {!onChoose && isWarehouse && wh && whProvider && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            {t('wizard.warehouseHint')}
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('wizard.whNamePlaceholder')} />
          <select
            value={whProvider.platform}
            onChange={(e) => { setWhPlatform(e.target.value); setWhFields({}); }}
            style={{ marginTop: 10, width: '100%' }}
          >
            {wh.providers.map((p) => <option key={p.platform} value={p.platform}>{p.label}</option>)}
          </select>
          <input
            type="text"
            value={whCatalog}
            onChange={(e) => setWhCatalog(e.target.value)}
            placeholder={t('wizard.whCatalogPlaceholder')}
            style={{ marginTop: 10 }}
            autoComplete="off"
          />
          {whProvider.credentialFields.map((f) => {
            const secret = whProvider.secretKeys.includes(f.key);
            // f.label / f.help are the provider's own metadata from the server (shown as sent).
            const base = f.required ? f.label : t('wizard.fieldOptional', { label: f.label });
            const withSecret = secret ? t('wizard.fieldSecret', { field: base }) : base;
            return (
              <input
                key={f.key}
                type={secret || f.kind === 'password' || f.kind === 'pem' ? 'password' : 'text'}
                value={whFields[f.key] ?? ''}
                onChange={(e) => setWhFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.help ? `${withSecret} — ${f.help}` : withSecret}
                style={{ marginTop: 10 }}
                autoComplete="off"
              />
            );
          })}
        </>
      ) : null}

      {/* ── OAUTH: Name (s === 0) ── */}
      {!onChoose && isOAuth && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            {tpl
              ? t.rich('wizard.oauthHint', { provider: tpl.label, strong: (c) => <strong>{c}</strong> })
              : t.rich('wizard.oauthHintGeneric', { strong: (c) => <strong>{c}</strong> })}
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl?.label ? t('wizard.oauthNamePlaceholder', { label: tpl.label }) : t('wizard.oauthNamePlaceholderGeneric')} />
        </>
      ) : null}

      {/* ── API/MCP: Endpoint (s === 0) ── */}
      {!onChoose && isApiConnector && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            {t.rich('wizard.apiHint', { strong: (c) => <strong>{c}</strong> })}
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('wizard.apiNamePlaceholder')} />
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={tpl ? t('wizard.webAddressHint', { hint: tpl.endpointHint }) : t('wizard.webAddress')}
            style={{ marginTop: 10 }}
          />
        </>
      ) : null}

      {/* ── API/MCP: Auth (s === 1) ── */}
      {!onChoose && isApiConnector && s === 1 ? (
        <>
          {/* Airflow: auth kind decides how the ONE credential is read (Bearer token vs
              Basic user:pass); the Basic username is non-secret. */}
          {template === 'airflow' ? (
            <>
              <label className="hint" style={{ display: 'block', marginTop: 0, marginBottom: 4 }}>{t('wizard.authLabel')}</label>
              <select value={airflowAuthType} onChange={(e) => setAirflowAuthType(e.target.value as 'bearer' | 'basic')} style={{ width: '100%', marginBottom: 10 }}>
                <option value="bearer">{t('wizard.airflowBearer')}</option>
                <option value="basic">{t('wizard.airflowBasic')}</option>
              </select>
              {airflowAuthType === 'basic' ? (
                <input type="text" value={airflowUsername} onChange={(e) => setAirflowUsername(e.target.value)} placeholder={t('wizard.airflowUsername')} style={{ marginBottom: 10 }} autoComplete="off" />
              ) : null}
            </>
          ) : null}
          {/* Atlassian: Basic (API token) REQUIRES the account email; Bearer (OAuth 3LO) does not. */}
          {template === 'atlassian' ? (
            <>
              <label className="hint" style={{ display: 'block', marginTop: 0, marginBottom: 4 }}>{t('wizard.authLabel')}</label>
              <select value={atlassianAuthKind} onChange={(e) => setAtlassianAuthKind(e.target.value as 'basic' | 'bearer')} style={{ width: '100%', marginBottom: 10 }}>
                <option value="basic">{t('wizard.atlassianBasic')}</option>
                <option value="bearer">{t('wizard.atlassianBearer')}</option>
              </select>
              {atlassianAuthKind === 'basic' ? (
                <input type="email" value={atlassianEmail} onChange={(e) => setAtlassianEmail(e.target.value)} placeholder={t('wizard.atlassianEmail')} style={{ marginBottom: 10 }} autoComplete="off" />
              ) : null}
            </>
          ) : null}
          {/* OData: OAuth-CC needs the token endpoint; Basic (communication user) does not. */}
          {template === 'sap-odata' || template === 'odata-v4' ? (
            <>
              <label className="hint" style={{ display: 'block', marginTop: 0, marginBottom: 4 }}>{t('wizard.authLabel')}</label>
              <select value={odataAuthType} onChange={(e) => setOdataAuthType(e.target.value as 'basic' | 'oauth-cc')} style={{ width: '100%', marginBottom: 10 }}>
                <option value="basic">{t('wizard.odataBasic')}</option>
                <option value="oauth-cc">{t('wizard.odataOauth')}</option>
              </select>
              {odataAuthType === 'oauth-cc' ? (
                <input type="text" value={odataTokenUrl} onChange={(e) => setOdataTokenUrl(e.target.value)} placeholder={t('wizard.odataTokenUrl')} style={{ marginBottom: 10 }} autoComplete="off" />
              ) : null}
            </>
          ) : null}
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={
              template === 'airflow' && airflowAuthType === 'basic' ? t('wizard.cred.password')
              : template === 'atlassian' && atlassianAuthKind === 'basic' ? t('wizard.cred.apiToken')
              : template === 'sap-odata' || template === 'odata-v4' ? (odataAuthType === 'oauth-cc' ? t('wizard.cred.clientCreds') : t('wizard.cred.userPassword'))
              : t('wizard.cred.generic')
            }
            autoComplete="off"
          />
          {/* Airflow trigger allowlist (optional; bounds trigger_dag to named DAGs). */}
          {template === 'airflow' ? (
            <input
              type="text"
              value={airflowDagAllowlist}
              onChange={(e) => setAirflowDagAllowlist(e.target.value)}
              placeholder={t('wizard.dagAllowlist')}
              style={{ marginTop: 10 }}
              autoComplete="off"
            />
          ) : null}
        </>
      ) : null}

      {/* ── API/MCP: Tools (s === 2) ── */}
      {!onChoose && isApiConnector && s === 2 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            {t('wizard.toolsHint')}
          </p>
          <textarea
            value={openApiSpec}
            onChange={(e) => setOpenApiSpec(e.target.value)}
            placeholder={t('wizard.specPlaceholder')}
            style={{ minHeight: 100, fontSize: 12, resize: 'vertical', width: '100%' }}
          />
        </>
      ) : null}

      {/* ── SERVICE (non-API, non-OAuth): endpoint + credential (s === 0) ── */}
      {!onChoose && !isOAuth && !isWarehouse && !isApiConnector && s === 0 ? (
        <>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('wizard.namePlaceholder')} />
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={tpl ? t('wizard.endpointHint', { hint: tpl.endpointHint }) : t('wizard.endpoint')}
            style={{ marginTop: 10 }}
          />
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={template === 'workday-raas' ? t('wizard.cred.isu') : t('wizard.cred.service')}
            style={{ marginTop: 10 }}
            autoComplete="off"
          />
          {/* Workday RaaS: each registered report IS an entity (no global describe). The
              connection has NO data until at least one report is registered — so offer the
              editor right here at create time. Add/remove report URL rows. */}
          {template === 'workday-raas' ? (
            <div style={{ marginTop: 12 }}>
              <label className="hint" style={{ display: 'block', marginBottom: 6 }}>
                {t('wizard.raasLabel')}
              </label>
              {workdayReports.map((r, i) => (
                <div key={i} className="row" style={{ gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <input
                      type="text"
                      value={r.path}
                      onChange={(e) => setWorkdayReports((prev) => prev.map((x, j) => j === i ? { ...x, path: e.target.value } : x))}
                      placeholder={t('wizard.reportPath')}
                      autoComplete="off"
                    />
                    <input
                      type="text"
                      value={r.key}
                      onChange={(e) => setWorkdayReports((prev) => prev.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                      placeholder={t('wizard.reportKey')}
                      style={{ marginTop: 6 }}
                      autoComplete="off"
                    />
                    <input
                      type="text"
                      value={r.label}
                      onChange={(e) => setWorkdayReports((prev) => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      placeholder={t('wizard.reportLabel')}
                      style={{ marginTop: 6 }}
                      autoComplete="off"
                    />
                  </div>
                  <button type="button" className="btn ghost" onClick={() => setWorkdayReports((prev) => prev.filter((_, j) => j !== i))} aria-label={t('wizard.removeReportAria')}>{t('wizard.remove')}</button>
                </div>
              ))}
              <button type="button" className="btn ghost" onClick={() => setWorkdayReports((prev) => [...prev, { path: '', key: '', label: '' }])}>
                {t('wizard.addReport')}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── Final "create / connect" summary step (OAuth 'Connect' + warehouse 'Register'
             add a trailing summary step; API/service create on their own last field step). ── */}
      {step === last && (isOAuth || isWarehouse) ? (
        <div style={{ marginTop: 4 }}>
          {isWarehouse ? (
            <p className="hint" style={{ marginTop: 0 }}>
              {t.rich('wizard.warehouseFinal', { strong: (c) => <strong>{c}</strong> })}
            </p>
          ) : isOAuth ? (
            <p className="hint" style={{ marginTop: 0 }}>
              {tpl?.label ? t('wizard.oauthFinal', { label: tpl.label }) : t('wizard.oauthFinalGeneric')}
            </p>
          ) : null}
        </div>
      ) : null}
      {step === last && isApiConnector ? (
        <p className="hint" style={{ marginTop: 4 }}>
          {t('wizard.apiFinal')}
        </p>
      ) : null}

      {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 12 }}>{msg}</div> : null}

      {/* ── Stepper controls ── */}
      {!done ? (
        <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end' }}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={creating}>{t('wizard.back')}</button>
          ) : null}
          {step < last ? (
            <button
              className="btn"
              onClick={() => setStep((v) => Math.min(last, v + 1))}
              disabled={!onChoose && !name.trim()}
            >
              {t('wizard.next')}
            </button>
          ) : (
            <button
              className="btn"
              onClick={isWarehouse ? createWarehouse : create}
              disabled={creating || !name.trim() || (isWarehouse && !whCatalog.trim())}
            >
              {creating ? <span className="spin" /> : isWarehouse ? t('wizard.createWarehouse') : isOAuth ? (tpl?.label ? t('wizard.addLabel', { label: tpl.label }) : t('wizard.addGeneric')) : t('wizard.createConnection')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
