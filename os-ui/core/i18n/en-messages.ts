/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    The English catalogs as ONE typed object — the source of the compile-time key check
 * USER STORY: As a contributor I mistype `t('nav.setings')` and the type check fails before review does.
 * ARCHITECTURE:
 *   - Type-only in practice: `core/i18n/next-intl.d.ts` declares next-intl's `AppConfig.Messages` as
 *     `typeof EN_MESSAGES`, so every `useTranslations(ns)` / `getTranslations(ns)` key is checked against the
 *     English source catalog. Nothing at run time imports this module (the request config loads catalogs itself).
 *   - Every namespace is listed from wave 1 on, so a later wave edits only its own JSON files, never this one.
 */
import shell from '../../messages/en/shell.json';
import common from '../../messages/en/common.json';
import settings from '../../messages/en/settings.json';
import server from '../../messages/en/server.json';
import admin from '../../messages/en/admin.json';
import agents from '../../messages/en/agents.json';
import connections from '../../messages/en/connections.json';
import dashboards from '../../messages/en/dashboards.json';
import data from '../../messages/en/data.json';
import files from '../../messages/en/files.json';
import governance from '../../messages/en/governance.json';
import home from '../../messages/en/home.json';
import knowledge from '../../messages/en/knowledge.json';
import metrics from '../../messages/en/metrics.json';
import monitoring from '../../messages/en/monitoring.json';
import software from '../../messages/en/software.json';
import workflows from '../../messages/en/workflows.json';

export const EN_MESSAGES = {
  shell, common, settings, server,
  admin, agents, connections, dashboards, data, files, governance,
  home, knowledge, metrics, monitoring, software, workflows,
};

export type AppMessages = typeof EN_MESSAGES;
