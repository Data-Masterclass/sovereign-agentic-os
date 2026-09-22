/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE, client-safe EDMX `$metadata` parser for OData V2 and V4 (operational-system-
 * connections.md, Phase 4). No secrets, no `server-only`, no I/O — a string of EDMX in,
 * a typed model out — so it is heavily unit-testable against fixture EDMX and shared by
 * the server client, the operational registry's discover, and (potentially) the UI.
 *
 * WHAT IT PARSES (deliberately narrow — only what the entity catalog + slice puller need):
 *   • EntitySets (name + which EntityType each binds) — the discoverable "tables".
 *   • EntityTypes: their scalar Properties (name, EDM type, nullable) and Key property
 *     refs. Navigation properties are IGNORED (a lakehouse column is a scalar; a nav is a
 *     link, not a value — Salesforce's compound/blob skip is the precedent).
 *   • SAP flavor annotations WHERE PRESENT, never invented:
 *       - `sap:label` on a property/entity type → the business label (else the API name).
 *       - `sap:creatable` / `sap:updatable` on an entity type (V2 SAP convention).
 *       - `sap:pageable` on an entity set.
 *     V4 SAP services carry these as `<Annotation Term="...">`; V2 as bare `sap:*` XML
 *     attributes. Both forms are read; an absent annotation is simply absent (honest).
 *
 * WHAT IT DELIBERATELY IGNORES: complex/enum types, functions/actions, associations &
 * referential constraints, containers beyond their EntitySets, and every EDM facet beyond
 * Nullable (MaxLength/Precision/Scale don't shape a Bronze column). This is a metadata
 * READER for cataloging + cursor detection, NOT a full CSDL implementation — stated
 * plainly so nobody mistakes its scope.
 *
 * XML approach: EDMX is well-formed XML but we avoid a DOM dependency (client-safe, tiny).
 * A tolerant tag/attribute scanner is enough for the flat element shapes above; it never
 * guesses — an element it cannot read yields nothing rather than a fabricated field.
 */

/** The OData protocol version the EDMX declares (from the root Edmx/DataServices version). */
export type ODataVersion = 'V2' | 'V4';

/** One scalar property of an entity type. */
export type ODataProperty = {
  /** The API name (the OData property name). */
  name: string;
  /** The EDM type, e.g. `Edm.String`, `Edm.DateTimeOffset` (verbatim, never mapped). */
  type: string;
  /** Whether the property is nullable (EDM default is true; V2/V4 both spell it `Nullable`). */
  nullable: boolean;
  /** The `sap:label` business label where present, else the API name (never invented). */
  label: string;
};

/** One entity type: its scalar properties, the key property names, and SAP CRUD flags. */
export type ODataEntityType = {
  name: string;
  properties: ODataProperty[];
  /** The key property names (from `<Key><PropertyRef Name="…"/></Key>`). */
  keys: string[];
  /** SAP `sap:label` on the type where present, else the type name. */
  label: string;
  /** SAP `sap:creatable` — undefined when the service declares no such annotation. */
  creatable?: boolean;
  /** SAP `sap:updatable` — undefined when the service declares no such annotation. */
  updatable?: boolean;
};

/** One entity set (the discoverable entity / "table"): its name + bound entity type. */
export type ODataEntitySet = {
  name: string;
  /** The bound EntityType name (unqualified — the last dotted segment). */
  entityType: string;
  /** SAP `sap:pageable` on the set — undefined when the service declares none. */
  pageable?: boolean;
  /** The business label (from the bound type's `sap:label`, else the set name). */
  label: string;
};

/** The parsed EDMX model — entity sets + a by-name entity-type map. */
export type ODataModel = {
  version: ODataVersion;
  entitySets: ODataEntitySet[];
  entityTypes: Record<string, ODataEntityType>;
};

/** Unqualify a dotted CSDL name — `NS.Type` → `Type`, `Type` → `Type`. */
function unqualify(name: string): string {
  const s = String(name ?? '').trim();
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s;
}

/** Read one XML attribute value by name from an element's attribute string (tolerant of
 *  single/double quotes and namespace prefixes on the attribute name). Returns null when
 *  absent — an absent attribute is never a fabricated value. */
function attr(attrs: string, name: string): string | null {
  // Match `name="..."` or `name='...'`, allowing a namespace prefix already in `name`.
  const re = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim();
}

/** Parse an SAP boolean annotation value: 'true'/'false' (V4) or bare present (V2 uses
 *  string 'true'/'false' too). Returns undefined when the annotation is absent. */
function sapBool(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return undefined;
}

/** Iterate the OPENING tags of a given local name across an XML string, yielding each
 *  element's attribute blob and its inner body (between the open and its matching close,
 *  or '' for a self-closing element). Deliberately shallow — good enough for the flat
 *  EDMX shapes we read; nested same-name elements are not expected here. */
function* elements(xml: string, local: string): Generator<{ attrs: string; body: string }> {
  // Local name may carry a namespace prefix (e.g. `edmx:DataServices`) — match either.
  const open = new RegExp(`<(?:[\\w.-]+:)?${local}(\\s[^>]*?)?(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    if (m[2] === '/') {
      yield { attrs, body: '' };
      continue;
    }
    // Find the matching close tag (non-nesting assumption for these shapes).
    const close = new RegExp(`</(?:[\\w.-]+:)?${local}\\s*>`, 'g');
    close.lastIndex = open.lastIndex;
    const c = close.exec(xml);
    const body = c ? xml.slice(open.lastIndex, c.index) : '';
    yield { attrs, body };
    if (c) open.lastIndex = close.lastIndex;
  }
}

/** Detect the EDMX/OData version. V4 declares `Version="4.0"` on the root Edmx (or the
 *  V4 edm namespace); V2 declares `Version="1.0"`/`2.0"` on `edmx:DataServices` and uses
 *  the 2008/09 edm namespace. Defaults to V4 when ambiguous (the modern default). */
export function detectODataVersion(edmx: string): ODataVersion {
  // Explicit DataServices m:DataServiceVersion is the strongest V2 signal.
  if (/DataServiceVersion\s*=\s*["']2\.0/i.test(edmx)) return 'V2';
  // The V2 CSDL namespaces (2006/2007/2008) vs the V4 namespace.
  if (/schemas\.microsoft\.com\/ado\/200[6-8]/i.test(edmx)) return 'V2';
  if (/oasis-open\.org\/odata\/ns\/edm/i.test(edmx)) return 'V4';
  if (/Version\s*=\s*["']4\.0/i.test(edmx)) return 'V4';
  return 'V4';
}

/** Read the SAP `sap:label` off an attribute blob (V2 bare attribute), else null. */
function sapLabelAttr(attrs: string): string | null {
  return attr(attrs, 'sap:label');
}

/**
 * V4 `<Annotation Term="…">` reader over an element body — SAP publishes labels/CRUD via
 * annotations rather than bare attributes in V4. Returns the string value of a
 * `Common.Label` / `SAP__common.Label` term, and boolean Capabilities flags. Only the
 * handful of terms the catalog needs are read; the rest are ignored (honest scope).
 */
function v4Annotations(body: string): { label?: string; creatable?: boolean; updatable?: boolean } {
  const out: { label?: string; creatable?: boolean; updatable?: boolean } = {};
  for (const a of elements(body, 'Annotation')) {
    const term = (attr(a.attrs, 'Term') ?? '').toLowerCase();
    if (term.endsWith('common.label') || term === 'sap:label') {
      const v = attr(a.attrs, 'String');
      if (v) out.label = v;
    }
    // Capabilities.InsertRestrictions/UpdateRestrictions carry an Insertable/Updatable
    // bool; a plain `sap:creatable`/`sap:updatable` term is also honored.
    if (term.endsWith('insertrestrictions') || term === 'sap:creatable') {
      const b = sapBool(attr(a.attrs, 'Bool'));
      if (b !== undefined) out.creatable = b;
    }
    if (term.endsWith('updaterestrictions') || term === 'sap:updatable') {
      const b = sapBool(attr(a.attrs, 'Bool'));
      if (b !== undefined) out.updatable = b;
    }
  }
  return out;
}

/** Parse one `<EntityType>` element (attrs + body) into an ODataEntityType. */
function parseEntityType(attrs: string, body: string): ODataEntityType {
  const name = attr(attrs, 'Name') ?? '';
  // Keys: <Key><PropertyRef Name="Id"/></Key>.
  const keys: string[] = [];
  for (const key of elements(body, 'Key')) {
    for (const ref of elements(key.body, 'PropertyRef')) {
      const kn = attr(ref.attrs, 'Name');
      if (kn) keys.push(kn);
    }
  }
  // Scalar properties (NavigationProperty is a different element — ignored).
  const properties: ODataProperty[] = [];
  for (const p of elements(body, 'Property')) {
    const pname = attr(p.attrs, 'Name');
    if (!pname) continue;
    const type = attr(p.attrs, 'Type') ?? '';
    // EDM default for Nullable is true; V2/V4 both spell the attribute `Nullable`.
    const nullableRaw = attr(p.attrs, 'Nullable');
    const nullable = nullableRaw === null ? true : nullableRaw.trim().toLowerCase() !== 'false';
    const v2Label = sapLabelAttr(p.attrs);
    const v4 = v4Annotations(p.body);
    const label = (v2Label ?? v4.label ?? pname).trim() || pname;
    properties.push({ name: pname, type, nullable, label });
  }
  const v2CreAttr = sapBool(attr(attrs, 'sap:creatable'));
  const v2UpdAttr = sapBool(attr(attrs, 'sap:updatable'));
  const typeAnn = v4Annotations(body);
  const v2TypeLabel = sapLabelAttr(attrs);
  const label = (v2TypeLabel ?? typeAnn.label ?? name).trim() || name;
  const creatable = v2CreAttr ?? typeAnn.creatable;
  const updatable = v2UpdAttr ?? typeAnn.updatable;
  return {
    name,
    properties,
    keys,
    label,
    ...(creatable !== undefined ? { creatable } : {}),
    ...(updatable !== undefined ? { updatable } : {}),
  };
}

/**
 * Parse an EDMX `$metadata` document (V2 or V4) into an {@link ODataModel}. Pure and
 * tolerant: an unparseable fragment yields fewer entries, NEVER a fabricated one. The
 * business `label` on a set/type/property is the `sap:label` where present, else the API
 * name — honest metadata, never invented.
 */
export function parseEdmx(edmx: string): ODataModel {
  const version = detectODataVersion(edmx);
  const entityTypes: Record<string, ODataEntityType> = {};
  for (const et of elements(edmx, 'EntityType')) {
    const t = parseEntityType(et.attrs, et.body);
    if (t.name) entityTypes[t.name] = t;
  }
  const entitySets: ODataEntitySet[] = [];
  for (const es of elements(edmx, 'EntitySet')) {
    const name = attr(es.attrs, 'Name');
    if (!name) continue;
    const boundType = unqualify(attr(es.attrs, 'EntityType') ?? '');
    const pageable = sapBool(attr(es.attrs, 'sap:pageable'));
    const bound = entityTypes[boundType];
    const label = (bound?.label ?? name).trim() || name;
    entitySets.push({
      name,
      entityType: boundType,
      ...(pageable !== undefined ? { pageable } : {}),
      label,
    });
  }
  return { version, entitySets, entityTypes };
}

/**
 * The honest cursor property for one entity type, DETECTED (never guessed) from a
 * date/time property whose name matches a known change-tracking convention. OData/SAP
 * services expose a last-changed timestamp under a handful of documented names; a type
 * that carries NONE is honestly full-refresh-only. Returns the property name + its EDM
 * type, or null.
 *
 * Detection rule (case-insensitive, EDM date/time type required so we never window on a
 * mislabeled string): the property's name is one of the well-known change columns AND its
 * type is an EDM temporal type. This mirrors the Salesforce SystemModstamp / Kajabi
 * documented-cursor discipline — nothing here is assumed.
 */
const CHANGE_COLUMN_NAMES = [
  'lastchangedatetime',
  'lastchangedon',
  'changedon',
  'changedat',
  'lastmodified',
  'lastmodifieddatetime',
  'lastmodifiedon',
  'modifiedat',
  'modifiedon',
  'sy_changedon',
];

const EDM_TEMPORAL = new Set(['edm.datetime', 'edm.datetimeoffset', 'edm.date']);

export function detectCursorProperty(type: ODataEntityType | undefined): { name: string; type: string } | null {
  if (!type) return null;
  for (const p of type.properties) {
    const nm = p.name.trim().toLowerCase();
    const ty = p.type.trim().toLowerCase();
    if (CHANGE_COLUMN_NAMES.includes(nm) && EDM_TEMPORAL.has(ty)) {
      return { name: p.name, type: p.type };
    }
  }
  return null;
}
