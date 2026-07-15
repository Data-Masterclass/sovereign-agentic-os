/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ConnectorWizard /> — the ONE shared stepper both create paths use.
 *
 * One component, one set of governed API calls (POST /api/connections). The steps
 * and fields are DRIVEN by the chosen template's metadata (auth kind + connector
 * kind + warehouse-provider fields) — never hardcoded per platform, so a new
 * template (om-catalog, airflow, …) that the API starts returning flows through
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

  // Shared form state.
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [openApiSpec, setOpenApiSpec] = useState('');
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
  const steps = useMemo<string[]>(() => {
    const choose = custom ? ['Choose'] : [];
    if (isWarehouse) return [...choose, 'Configure', 'Register'];
    if (isOAuth) return [...choose, 'Name', 'Connect'];
    if (isApiConnector) return [...choose, 'Endpoint', 'Auth', 'Tools', 'Create'];
    return [...choose, 'Credential', 'Create'];
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
      if (!res.ok || !resp.connection) { setMsg(`✗ ${resp.error ?? 'Could not create warehouse connection'}`); return; }
      setMsg(`✓ Created "${resp.connection.name}" (${whProvider.label}). Finish on its card: Register the Trino catalog, then Test → Browse. Secrets went to Secrets Manager (never the record).`);
      setDone(true);
      onDone();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setCreating(false); }
  }

  async function create() {
    if (!name.trim() || creating) return;
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
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resp = await res.json() as { connection?: Conn; error?: string };
      if (!res.ok || !resp.connection) { setMsg(`✗ ${resp.error ?? 'Could not create connection'}`); return; }
      const c = resp.connection;
      const ref = `${c.secretRef.name}/${c.secretRef.key}`;
      setMsg(isOAuth
        ? `✓ Created "${c.name}". Now click Connect on its card below to sign in and authorize your own account. The token goes to Secrets Manager as ref ${ref} (never the value).`
        : `✓ Created "${c.name}". Credential stored as ref ${ref} (never the value).`);
      setDone(true);
      onDone();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setCreating(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 18, borderColor: 'var(--gold-line)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <ol className="sb-steps" aria-label="Connector steps" style={{ marginBottom: 0 }}>
          {steps.map((label, i) => (
            <li key={label} className={`sb-step${step === i ? ' active' : ''}${step > i || done ? ' done' : ''}`}>
              <button type="button" onClick={() => !done && setStep(i)} disabled={done}>
                <span className="sb-step-n">{step > i || done ? '✓' : i + 1}</span>
                <span className="sb-step-label">{label}</span>
              </button>
            </li>
          ))}
        </ol>
        <button className="btn ghost" onClick={onCancel}>{done ? 'Close' : 'Cancel'}</button>
      </div>

      {/* ── CUSTOM: Choose the connector type ── */}
      {onChoose ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Connect an external system as a governed connection. Pick its type — the next steps adapt
            to it. Each stores only a token <em>reference</em> (never the value); external endpoints are
            checked against the egress allowlist.
          </p>
          <select value={template} onChange={(e) => setTemplate(e.target.value)} style={{ width: '100%' }}>
            {pickable.map((o) => <option key={o.key} value={o.key}>{o.label} · {o.type}</option>)}
          </select>
        </>
      ) : null}

      {/* ── WAREHOUSE: platform + catalog + provider fields (from provider metadata) ── */}
      {!onChoose && isWarehouse && wh && whProvider && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Federate an external lakehouse as ONE governed Trino catalog. <strong>Secret</strong> fields
            go to Secrets Manager, the rest onto the record. Registration is finished on the card
            (Register → Test → Browse).
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Connection name (e.g. Sales warehouse)" />
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
            placeholder="Trino catalog name (e.g. glue_sales) — [a-z_][a-z0-9_]*"
            style={{ marginTop: 10 }}
            autoComplete="off"
          />
          {whProvider.credentialFields.map((f) => {
            const secret = whProvider.secretKeys.includes(f.key);
            return (
              <input
                key={f.key}
                type={secret || f.kind === 'password' || f.kind === 'pem' ? 'password' : 'text'}
                value={whFields[f.key] ?? ''}
                onChange={(e) => setWhFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={`${f.label}${f.required ? '' : ' (optional)'}${secret ? ' — to Secrets Manager' : ''}${f.help ? ` — ${f.help}` : ''}`}
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
            Name this connection, then click <strong>Connect</strong> on its card to sign in through
            {tpl ? ` ${tpl.label}` : ' the provider'} and authorize your own account. OAuth completes
            server-side; the token goes to Secrets Manager — never the browser. Private to you (<strong>Personal</strong>).
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Connection name (e.g. My ${tpl?.label ?? 'account'})`} />
        </>
      ) : null}

      {/* ── API/MCP: Endpoint (s === 0) ── */}
      {!onChoose && isApiConnector && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Connect an outbound <strong>{tpl?.type ?? 'API'}</strong>. Give it a name and its endpoint URL.
            The host must be on the egress allowlist.
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Connection name (e.g. Salesforce API)" />
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={tpl ? `Endpoint (e.g. ${tpl.endpointHint})` : 'Endpoint URL'}
            style={{ marginTop: 10 }}
          />
        </>
      ) : null}

      {/* ── API/MCP: Auth (s === 1) ── */}
      {!onChoose && isApiConnector && s === 1 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            The credential is stored once in <strong>Secrets Manager</strong> — never in the record or the
            browser. Only a reference is kept.
          </p>
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="Credential (API key / token) — goes to Secrets Manager"
            autoComplete="off"
          />
        </>
      ) : null}

      {/* ── API/MCP: Tools (s === 2) ── */}
      {!onChoose && isApiConnector && s === 2 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            Optional: paste an OpenAPI spec and the governed tools this connector exposes are generated from
            it. Each becomes a per-tool capability you tune (Read / Write-bounded / Write-approval / Blocked)
            on the connection&apos;s card after it&apos;s created.
          </p>
          <textarea
            value={openApiSpec}
            onChange={(e) => setOpenApiSpec(e.target.value)}
            placeholder="Optional: paste OpenAPI spec (JSON or YAML)"
            style={{ minHeight: 100, fontSize: 12, resize: 'vertical', width: '100%' }}
          />
        </>
      ) : null}

      {/* ── SERVICE (non-API, non-OAuth): endpoint + credential (s === 0) ── */}
      {!onChoose && !isOAuth && !isWarehouse && !isApiConnector && s === 0 ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            The credential is stored once in <strong>Secrets Manager</strong> — never in the record or the browser.
          </p>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Connection name" />
          <input
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={tpl ? `Endpoint (e.g. ${tpl.endpointHint})` : 'Endpoint'}
            style={{ marginTop: 10 }}
          />
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="Credential (API key / token / password) — goes to Secrets Manager"
            style={{ marginTop: 10 }}
            autoComplete="off"
          />
        </>
      ) : null}

      {/* ── Final "create / connect" summary step (OAuth 'Connect' + warehouse 'Register'
             add a trailing summary step; API/service create on their own last field step). ── */}
      {step === last && (isOAuth || isWarehouse) ? (
        <div style={{ marginTop: 4 }}>
          {isWarehouse ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Create the connection, then finish on its card: <strong>Register</strong> the Trino catalog
              (one click — a rolling restart), <strong>Test</strong> (SHOW SCHEMAS), then <strong>Browse</strong>.
            </p>
          ) : isOAuth ? (
            <p className="hint" style={{ marginTop: 0 }}>
              Add {tpl?.label ?? 'the connection'}, then Connect on its card to authorize your own account.
            </p>
          ) : null}
        </div>
      ) : null}
      {step === last && isApiConnector ? (
        <p className="hint" style={{ marginTop: 4 }}>
          Create the connection. Governed tools are exposed under policy; tune each on its card.
        </p>
      ) : null}

      {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 12 }}>{msg}</div> : null}

      {/* ── Stepper controls ── */}
      {!done ? (
        <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end' }}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={creating}>Back</button>
          ) : null}
          {step < last ? (
            <button
              className="btn"
              onClick={() => setStep((v) => Math.min(last, v + 1))}
              disabled={!onChoose && !name.trim()}
            >
              Next
            </button>
          ) : (
            <button
              className="btn"
              onClick={isWarehouse ? createWarehouse : create}
              disabled={creating || !name.trim() || (isWarehouse && !whCatalog.trim())}
            >
              {creating ? <span className="spin" /> : isWarehouse ? 'Create warehouse connection' : isOAuth ? `Add ${tpl?.label ?? 'connection'}` : 'Create connection'}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
