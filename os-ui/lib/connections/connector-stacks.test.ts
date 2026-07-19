/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTION_TEMPLATES } from './schema';
import { vendorStack, warehousePlatformStack, STACKS, type StackId } from './connector-stacks';

const VALID_STACK_IDS: StackId[] = STACKS.map((s) => s.id);

describe('vendorStack', () => {
  it('maps every CONNECTION_TEMPLATES key to a defined stack (no orphans)', () => {
    for (const tpl of CONNECTION_TEMPLATES) {
      const id = vendorStack(tpl.key);
      assert.ok(
        VALID_STACK_IDS.includes(id),
        `Template "${tpl.key}" mapped to unknown stack "${id}"`,
      );
    }
  });

  it('entra → microsoft', () => {
    assert.equal(vendorStack('entra'), 'microsoft');
  });

  it('bigquery (warehouse platform) → google', () => {
    assert.equal(warehousePlatformStack('bigquery'), 'google');
  });

  it('onedrive → microsoft', () => {
    assert.equal(vendorStack('onedrive'), 'microsoft');
  });

  it('gmail → google', () => {
    assert.equal(vendorStack('gmail'), 'google');
  });

  it('sagemaker → aws', () => {
    assert.equal(vendorStack('sagemaker'), 'aws');
  });

  it('snowflake-governance → snowflake', () => {
    assert.equal(vendorStack('snowflake-governance'), 'snowflake');
  });

  it('salesforce-api → salesforce', () => {
    assert.equal(vendorStack('salesforce-api'), 'salesforce');
  });

  it('atlassian → atlassian', () => {
    assert.equal(vendorStack('atlassian'), 'atlassian');
  });

  it('github → opensource', () => {
    assert.equal(vendorStack('github'), 'opensource');
  });

  it('generic-api → other', () => {
    assert.equal(vendorStack('generic-api'), 'other');
  });

  it('generic-mcp → other', () => {
    assert.equal(vendorStack('generic-mcp'), 'other');
  });

  it('unknown key → other (fallback)', () => {
    assert.equal(vendorStack('totally-unknown-key'), 'other');
  });

  it('warehousePlatformStack: databricks-delta → databricks', () => {
    assert.equal(warehousePlatformStack('databricks-delta'), 'databricks');
  });

  it('warehousePlatformStack: fabric → microsoft', () => {
    assert.equal(warehousePlatformStack('fabric'), 'microsoft');
  });

  it('warehousePlatformStack: glue → aws', () => {
    assert.equal(warehousePlatformStack('glue'), 'aws');
  });

  it('warehousePlatformStack: unknown → other (fallback)', () => {
    assert.equal(warehousePlatformStack('mystery-db'), 'other');
  });
});
