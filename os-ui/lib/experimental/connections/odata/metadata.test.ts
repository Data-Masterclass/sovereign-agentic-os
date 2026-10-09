/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * EDMX $metadata parser (operational-system-connections.md, Phase 4). Pure: no network,
 * no secrets. Tested against a V2 SAP-flavored fixture and a V4 fixture — entity sets,
 * entity types, properties (name/type/nullable/key), and SAP annotations (sap:label,
 * creatable/updatable/pageable) where present; cursor detection honesty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEdmx, detectODataVersion, detectCursorProperty } from './metadata.ts';

// A V2, SAP-flavored EDMX (bare `sap:*` attributes; 2008 CSDL namespace; DataServiceVersion 2.0).
const V2_SAP = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"
  xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"
  xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="API_BP" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="BusinessPartner" sap:label="Business Partner" sap:creatable="false" sap:updatable="true">
        <Key><PropertyRef Name="BusinessPartner"/></Key>
        <Property Name="BusinessPartner" Type="Edm.String" Nullable="false" sap:label="BP Number"/>
        <Property Name="BusinessPartnerName" Type="Edm.String" Nullable="true" sap:label="Name"/>
        <Property Name="LastChangeDateTime" Type="Edm.DateTimeOffset" Nullable="true" sap:label="Changed On"/>
        <NavigationProperty Name="to_Address" Relationship="API_BP.Assoc"/>
      </EntityType>
      <EntityContainer Name="Container" m:IsDefaultEntityContainer="true">
        <EntitySet Name="A_BusinessPartner" EntityType="API_BP.BusinessPartner" sap:pageable="true"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

// A V4 EDMX (OASIS edm namespace; V4 Annotation elements for the label).
const V4 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Sales" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Account">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Name" Type="Edm.String">
          <Annotation Term="Common.Label" String="Account Name"/>
        </Property>
        <Property Name="ModifiedOn" Type="Edm.DateTimeOffset" Nullable="true"/>
      </EntityType>
      <EntityContainer Name="Service">
        <EntitySet Name="Accounts" EntityType="Sales.Account"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

test('detectODataVersion: V2 SAP vs V4', () => {
  assert.equal(detectODataVersion(V2_SAP), 'V2');
  assert.equal(detectODataVersion(V4), 'V4');
});

test('parseEdmx V2 SAP: entity set, type, properties, keys, sap annotations', () => {
  const m = parseEdmx(V2_SAP);
  assert.equal(m.version, 'V2');
  assert.equal(m.entitySets.length, 1);
  const set = m.entitySets[0];
  assert.equal(set.name, 'A_BusinessPartner');
  assert.equal(set.entityType, 'BusinessPartner');
  assert.equal(set.pageable, true);
  // The set label rides the bound type's sap:label.
  assert.equal(set.label, 'Business Partner');

  const t = m.entityTypes.BusinessPartner;
  assert.ok(t);
  assert.deepEqual(t.keys, ['BusinessPartner']);
  assert.equal(t.creatable, false);
  assert.equal(t.updatable, true);
  // Scalar properties only — the NavigationProperty is ignored.
  assert.equal(t.properties.length, 3);
  const bp = t.properties.find((p) => p.name === 'BusinessPartner')!;
  assert.equal(bp.type, 'Edm.String');
  assert.equal(bp.nullable, false); // Nullable="false"
  assert.equal(bp.label, 'BP Number'); // sap:label
  const name = t.properties.find((p) => p.name === 'BusinessPartnerName')!;
  assert.equal(name.nullable, true);
  assert.equal(name.label, 'Name');
});

test('parseEdmx V4: label from Annotation, EDM default nullable=true, nav ignored', () => {
  const m = parseEdmx(V4);
  assert.equal(m.version, 'V4');
  assert.equal(m.entitySets[0].name, 'Accounts');
  assert.equal(m.entitySets[0].entityType, 'Account');
  const t = m.entityTypes.Account;
  assert.deepEqual(t.keys, ['Id']);
  const id = t.properties.find((p) => p.name === 'Id')!;
  assert.equal(id.nullable, false);
  assert.equal(id.label, 'Id'); // no label → falls back to API name (never invented)
  const nm = t.properties.find((p) => p.name === 'Name')!;
  assert.equal(nm.label, 'Account Name'); // V4 Common.Label annotation
  // ModifiedOn has no explicit Nullable → EDM default true.
  assert.equal(t.properties.find((p) => p.name === 'ModifiedOn')!.nullable, true);
});

test('detectCursorProperty: honest — a documented change-timestamp of a temporal type', () => {
  const m2 = parseEdmx(V2_SAP);
  const c2 = detectCursorProperty(m2.entityTypes.BusinessPartner);
  assert.ok(c2);
  assert.equal(c2!.name, 'LastChangeDateTime');
  assert.equal(c2!.type, 'Edm.DateTimeOffset');

  const m4 = parseEdmx(V4);
  const c4 = detectCursorProperty(m4.entityTypes.Account);
  assert.ok(c4);
  assert.equal(c4!.name, 'ModifiedOn');
});

test('detectCursorProperty: NOT guessed — no change-timestamp ⇒ null (full-refresh-only)', () => {
  const noCursor = parseEdmx(`<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
    <edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Guid"/>
        <Property Name="Price" Type="Edm.Decimal"/>
        <Property Name="Description" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="S"><EntitySet Name="Products" EntityType="X.Product"/></EntityContainer>
    </Schema></edmx:DataServices></edmx:Edmx>`);
  assert.equal(detectCursorProperty(noCursor.entityTypes.Product), null);
});

test('detectCursorProperty: a change-named STRING is rejected (temporal type required)', () => {
  const m = parseEdmx(`<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
    <edmx:DataServices><Schema xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="T"><Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Guid"/>
        <Property Name="ChangedOn" Type="Edm.String"/>
      </EntityType></Schema></edmx:DataServices></edmx:Edmx>`);
  assert.equal(detectCursorProperty(m.entityTypes.T), null);
});
