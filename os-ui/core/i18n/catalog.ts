/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       i18n
 * FEATURE:    One language's catalogs — every namespace, English laid underneath
 * USER STORY: As a user I see my language everywhere a wave has translated it and English everywhere else,
 *             never a raw key.
 * ARCHITECTURE:
 *   - The catalogs live in `os-ui/messages/<locale>/<namespace>.json` (layout enforced by scripts/check-i18n.mjs).
 *     They are imported STATICALLY (no dynamic import the glue check cannot verify, no runtime file read the
 *     standalone build would have to trace). Every namespace file exists in every locale from wave 1 on, so this
 *     list never changes when a wave converts a tab — waves edit only their JSON files. Adding a namespace or a
 *     language is the one deliberate change here (with config.ts, en-messages.ts and check-i18n.mjs).
 *   - The result is keyed by namespace (`{ shell: {...}, data: {...} }`), which is what next-intl's
 *     `useTranslations('shell')` reads, and is English-merged (`withEnglishFallback`).
 *   - Server-side only (the request config); the client receives the active language's messages through
 *     `NextIntlClientProvider`.
 */
import { DEFAULT_LOCALE, NAMESPACES, type Locale, type Namespace } from '@core/i18n/config';
import { withEnglishFallback, type MessageTree } from '@core/i18n/fallback';
import en_shell from '../../messages/en/shell.json';
import en_common from '../../messages/en/common.json';
import en_settings from '../../messages/en/settings.json';
import en_server from '../../messages/en/server.json';
import en_admin from '../../messages/en/admin.json';
import en_agents from '../../messages/en/agents.json';
import en_connections from '../../messages/en/connections.json';
import en_dashboards from '../../messages/en/dashboards.json';
import en_data from '../../messages/en/data.json';
import en_files from '../../messages/en/files.json';
import en_governance from '../../messages/en/governance.json';
import en_home from '../../messages/en/home.json';
import en_knowledge from '../../messages/en/knowledge.json';
import en_metrics from '../../messages/en/metrics.json';
import en_monitoring from '../../messages/en/monitoring.json';
import en_software from '../../messages/en/software.json';
import en_workflows from '../../messages/en/workflows.json';
import de_shell from '../../messages/de/shell.json';
import de_common from '../../messages/de/common.json';
import de_settings from '../../messages/de/settings.json';
import de_server from '../../messages/de/server.json';
import de_admin from '../../messages/de/admin.json';
import de_agents from '../../messages/de/agents.json';
import de_connections from '../../messages/de/connections.json';
import de_dashboards from '../../messages/de/dashboards.json';
import de_data from '../../messages/de/data.json';
import de_files from '../../messages/de/files.json';
import de_governance from '../../messages/de/governance.json';
import de_home from '../../messages/de/home.json';
import de_knowledge from '../../messages/de/knowledge.json';
import de_metrics from '../../messages/de/metrics.json';
import de_monitoring from '../../messages/de/monitoring.json';
import de_software from '../../messages/de/software.json';
import de_workflows from '../../messages/de/workflows.json';
import fr_shell from '../../messages/fr/shell.json';
import fr_common from '../../messages/fr/common.json';
import fr_settings from '../../messages/fr/settings.json';
import fr_server from '../../messages/fr/server.json';
import fr_admin from '../../messages/fr/admin.json';
import fr_agents from '../../messages/fr/agents.json';
import fr_connections from '../../messages/fr/connections.json';
import fr_dashboards from '../../messages/fr/dashboards.json';
import fr_data from '../../messages/fr/data.json';
import fr_files from '../../messages/fr/files.json';
import fr_governance from '../../messages/fr/governance.json';
import fr_home from '../../messages/fr/home.json';
import fr_knowledge from '../../messages/fr/knowledge.json';
import fr_metrics from '../../messages/fr/metrics.json';
import fr_monitoring from '../../messages/fr/monitoring.json';
import fr_software from '../../messages/fr/software.json';
import fr_workflows from '../../messages/fr/workflows.json';
import es_shell from '../../messages/es/shell.json';
import es_common from '../../messages/es/common.json';
import es_settings from '../../messages/es/settings.json';
import es_server from '../../messages/es/server.json';
import es_admin from '../../messages/es/admin.json';
import es_agents from '../../messages/es/agents.json';
import es_connections from '../../messages/es/connections.json';
import es_dashboards from '../../messages/es/dashboards.json';
import es_data from '../../messages/es/data.json';
import es_files from '../../messages/es/files.json';
import es_governance from '../../messages/es/governance.json';
import es_home from '../../messages/es/home.json';
import es_knowledge from '../../messages/es/knowledge.json';
import es_metrics from '../../messages/es/metrics.json';
import es_monitoring from '../../messages/es/monitoring.json';
import es_software from '../../messages/es/software.json';
import es_workflows from '../../messages/es/workflows.json';
import it_shell from '../../messages/it/shell.json';
import it_common from '../../messages/it/common.json';
import it_settings from '../../messages/it/settings.json';
import it_server from '../../messages/it/server.json';
import it_admin from '../../messages/it/admin.json';
import it_agents from '../../messages/it/agents.json';
import it_connections from '../../messages/it/connections.json';
import it_dashboards from '../../messages/it/dashboards.json';
import it_data from '../../messages/it/data.json';
import it_files from '../../messages/it/files.json';
import it_governance from '../../messages/it/governance.json';
import it_home from '../../messages/it/home.json';
import it_knowledge from '../../messages/it/knowledge.json';
import it_metrics from '../../messages/it/metrics.json';
import it_monitoring from '../../messages/it/monitoring.json';
import it_software from '../../messages/it/software.json';
import it_workflows from '../../messages/it/workflows.json';
import pl_shell from '../../messages/pl/shell.json';
import pl_common from '../../messages/pl/common.json';
import pl_settings from '../../messages/pl/settings.json';
import pl_server from '../../messages/pl/server.json';
import pl_admin from '../../messages/pl/admin.json';
import pl_agents from '../../messages/pl/agents.json';
import pl_connections from '../../messages/pl/connections.json';
import pl_dashboards from '../../messages/pl/dashboards.json';
import pl_data from '../../messages/pl/data.json';
import pl_files from '../../messages/pl/files.json';
import pl_governance from '../../messages/pl/governance.json';
import pl_home from '../../messages/pl/home.json';
import pl_knowledge from '../../messages/pl/knowledge.json';
import pl_metrics from '../../messages/pl/metrics.json';
import pl_monitoring from '../../messages/pl/monitoring.json';
import pl_software from '../../messages/pl/software.json';
import pl_workflows from '../../messages/pl/workflows.json';
import cs_shell from '../../messages/cs/shell.json';
import cs_common from '../../messages/cs/common.json';
import cs_settings from '../../messages/cs/settings.json';
import cs_server from '../../messages/cs/server.json';
import cs_admin from '../../messages/cs/admin.json';
import cs_agents from '../../messages/cs/agents.json';
import cs_connections from '../../messages/cs/connections.json';
import cs_dashboards from '../../messages/cs/dashboards.json';
import cs_data from '../../messages/cs/data.json';
import cs_files from '../../messages/cs/files.json';
import cs_governance from '../../messages/cs/governance.json';
import cs_home from '../../messages/cs/home.json';
import cs_knowledge from '../../messages/cs/knowledge.json';
import cs_metrics from '../../messages/cs/metrics.json';
import cs_monitoring from '../../messages/cs/monitoring.json';
import cs_software from '../../messages/cs/software.json';
import cs_workflows from '../../messages/cs/workflows.json';

const CATALOGS: Record<Locale, Record<Namespace, MessageTree>> = {
  en: { shell: en_shell, common: en_common, settings: en_settings, server: en_server, admin: en_admin, agents: en_agents, connections: en_connections, dashboards: en_dashboards, data: en_data, files: en_files, governance: en_governance, home: en_home, knowledge: en_knowledge, metrics: en_metrics, monitoring: en_monitoring, software: en_software, workflows: en_workflows },
  de: { shell: de_shell, common: de_common, settings: de_settings, server: de_server, admin: de_admin, agents: de_agents, connections: de_connections, dashboards: de_dashboards, data: de_data, files: de_files, governance: de_governance, home: de_home, knowledge: de_knowledge, metrics: de_metrics, monitoring: de_monitoring, software: de_software, workflows: de_workflows },
  fr: { shell: fr_shell, common: fr_common, settings: fr_settings, server: fr_server, admin: fr_admin, agents: fr_agents, connections: fr_connections, dashboards: fr_dashboards, data: fr_data, files: fr_files, governance: fr_governance, home: fr_home, knowledge: fr_knowledge, metrics: fr_metrics, monitoring: fr_monitoring, software: fr_software, workflows: fr_workflows },
  es: { shell: es_shell, common: es_common, settings: es_settings, server: es_server, admin: es_admin, agents: es_agents, connections: es_connections, dashboards: es_dashboards, data: es_data, files: es_files, governance: es_governance, home: es_home, knowledge: es_knowledge, metrics: es_metrics, monitoring: es_monitoring, software: es_software, workflows: es_workflows },
  it: { shell: it_shell, common: it_common, settings: it_settings, server: it_server, admin: it_admin, agents: it_agents, connections: it_connections, dashboards: it_dashboards, data: it_data, files: it_files, governance: it_governance, home: it_home, knowledge: it_knowledge, metrics: it_metrics, monitoring: it_monitoring, software: it_software, workflows: it_workflows },
  pl: { shell: pl_shell, common: pl_common, settings: pl_settings, server: pl_server, admin: pl_admin, agents: pl_agents, connections: pl_connections, dashboards: pl_dashboards, data: pl_data, files: pl_files, governance: pl_governance, home: pl_home, knowledge: pl_knowledge, metrics: pl_metrics, monitoring: pl_monitoring, software: pl_software, workflows: pl_workflows },
  cs: { shell: cs_shell, common: cs_common, settings: cs_settings, server: cs_server, admin: cs_admin, agents: cs_agents, connections: cs_connections, dashboards: cs_dashboards, data: cs_data, files: cs_files, governance: cs_governance, home: cs_home, knowledge: cs_knowledge, metrics: cs_metrics, monitoring: cs_monitoring, software: cs_software, workflows: cs_workflows },
};

/** The whole catalog for `locale`, each namespace merged over English. */
export function loadMessages(locale: Locale): MessageTree {
  const out: MessageTree = {};
  for (const ns of NAMESPACES) {
    const en = CATALOGS[DEFAULT_LOCALE][ns];
    out[ns] = locale === DEFAULT_LOCALE ? en : withEnglishFallback(en, CATALOGS[locale][ns]);
  }
  return out;
}
