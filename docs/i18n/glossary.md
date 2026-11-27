<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# i18n glossary — fixed terms per language

Every wave uses these terms, so the OS reads as one product in every language. When a term is not here, write
natural, concise product copy (not a literal translation) and add the term in the same pull request.

**Address:** informal everywhere — de *du*, fr *tu*, es *tú*, it *tu*, pl *ty*, cs *ty*. Imperatives in the
informal form ("Speichere", "Enregistre", "Guarda", "Salva", "Zapisz", "Ulož"). Polish keeps the polite capital
in running copy (*Twoje*, *Ciebie*) as is customary in product UI; the address stays informal.

**Never translated** (the check allows them in converted code as literals — `BRAND_TERMS` in
`scripts/check-i18n.mjs`): Agentic OS, Sovereign Agentic OS, Data Masterclass, MCP, Trino, Iceberg, LiteLLM,
Langfuse, LangGraph, OpenSearch, Dagster, dbt, OPA, Docling, Trivy, OKF, Superset, ECharts, Kubernetes, Helm,
GitHub, GitLab, Next.js, React, Node — and every other product name. Role names stay English and lowercase as the
OS shows them: `creator`, `builder`, `domain_admin`, `admin`. Environment variables, ids, SQL and code are never
translated. **User content is never translated**: dataset, file, knowledge, agent and dashboard names, domain ids,
and anything a person typed.

**Machine-facing text stays English:** MCP tool names, tool descriptions and typed MCP error codes.

## Product terms

| English | de | fr | es | it | pl | cs |
|---|---|---|---|---|---|---|
| dataset | Datensatz | jeu de données | conjunto de datos | dataset | zbiór danych | datová sada |
| data product | Datenprodukt | produit de données | producto de datos | data product | produkt danych | datový produkt |
| knowledge | Wissen | connaissances | conocimiento | conoscenza | wiedza | znalosti |
| connection | Verbindung | connexion | conexión | connessione | połączenie | připojení |
| file | Datei | fichier | archivo | file | plik | soubor |
| agent | Agent | agent | agente | agente | agent | agent |
| agent system | Agentensystem | système d'agents | sistema de agentes | sistema di agenti | system agentów | systém agentů |
| run (noun, one execution) | Lauf | exécution | ejecución | esecuzione | uruchomienie | běh |
| Run (the Studio / Run surface) | Betrieb | Production | Producción | Produzione | Produkcja | Provoz |
| Studio | Studio | Studio | Estudio | Studio | Studio | Studio |
| approval | Freigabe | approbation | aprobación | approvazione | zatwierdzenie | schválení |
| go live | live schalten | mettre en ligne | publicar | pubblicare | uruchomić produkcyjnie | spustit naostro |
| promote (scope up) | hochstufen | promouvoir | promover | promuovere | awansować | povýšit |
| demote | zurückstufen | rétrograder | degradar | riportare | przenieść niżej | vrátit |
| domain | Domäne | domaine | dominio | dominio | domena | doména |
| scope: My | Meine | Mes | Mis | Miei | Moje | Moje |
| scope: Domain | Domäne | Domaine | Dominio | Dominio | Domena | Doména |
| scope: Company | Unternehmen | Entreprise | Empresa | Azienda | Firma | Firma |
| Personal (tier) | Persönlich | Personnel | Personal | Personale | Osobiste | Osobní |
| metric | Kennzahl | métrique | métrica | metrica | metryka | metrika |
| KPI / KPIs (the tab) | KPIs | KPI | KPI | KPI | KPI | KPI |
| dashboard | Dashboard | tableau de bord | panel | dashboard | pulpit | dashboard |
| workflow | Workflow | workflow | flujo de trabajo | workflow | przepływ pracy | workflow |
| DQ check (data quality) | DQ-Prüfung | contrôle DQ | comprobación de DQ | controllo DQ | kontrola DQ | kontrola DQ |
| bronze / silver / gold | Bronze / Silber / Gold | bronze / argent / or | bronce / plata / oro | bronze / argento / oro | brąz / srebro / złoto | bronz / stříbro / zlato |
| governance | Governance | gouvernance | gobernanza | governance | nadzór | governance |
| monitoring | Monitoring | supervision | monitorización | monitoraggio | monitorowanie | monitoring |
| platform | Plattform | plateforme | plataforma | piattaforma | platforma | platforma |
| tenant | Mandant | tenant | tenant | tenant | tenant | tenant |
| notification | Benachrichtigung | notification | notificación | notifica | powiadomienie | oznámení |
| settings | Einstellungen | paramètres | ajustes | impostazioni | ustawienia | nastavení |
| sign in / sign out | anmelden / abmelden | se connecter / se déconnecter | iniciar / cerrar sesión | accedi / esci | zaloguj / wyloguj się | přihlásit / odhlásit se |
| Ask the OS | Frag das OS | Demande à l'OS | Pregunta al OS | Chiedi all'OS | Zapytaj OS | Zeptej se OS |
| Under the hood | Unter der Haube | Sous le capot | Bajo el capó | Dietro le quinte | Pod maską | Pod kapotou |

## Wave 2 terms (Home, Files, Knowledge)

| English | de | fr | es | it | pl | cs |
|---|---|---|---|---|---|---|
| golden paths | Goldene Pfade | parcours guidés | rutas guiadas | percorsi guidati | złote ścieżki | zlaté cesty |
| governed | verwaltet | gouverné | gobernado | governato | nadzorowany | řízený |
| recovery key | Wiederherstellungsschlüssel | clé de récupération | clave de recuperación | chiave di recupero | klucz odzyskiwania | klíč pro obnovení |
| tag | Tag | tag | etiqueta | tag | tag | štítek |
| upload | hochladen | téléverser | subir | caricare | przesłać | nahrát |
| archive | archivieren | archiver | archivar | archiviare | archiwizować | archivovat |
| lineage | Herkunft | lignage | linaje | lineage | pochodzenie | původ |
| sensitivity: public / internal / confidential / restricted | öffentlich / intern / vertraulich / eingeschränkt | public / interne / confidentiel / restreint | público / interno / confidencial / restringido | pubblico / interno / riservato / ristretto | publiczne / wewnętrzne / poufne / zastrzeżone | veřejné / interní / důvěrné / omezené |
| searchable | durchsuchbar | consultable | buscable | ricercabile | wyszukiwalny | vyhledatelný |
| step | Schritt | étape | paso | passaggio | krok | krok |
| actor | Akteur | acteur | actor | attore | aktor | aktér |
| swimlane | Swimlane | couloir | carril | corsia | tor | dráha |
| business rule | Geschäftsregel | règle métier | regla de negocio | regola di business | reguła biznesowa | obchodní pravidlo |
| hard / soft rule | hart / weich | stricte / souple | estricta / flexible | rigida / flessibile | twarda / miękka | pevné / měkké |
| guardrail | Leitplanke | garde-fou | salvaguarda | guardrail | zabezpieczenie | ochranné pravidlo |
| handover | Übergabe | transmission | traspaso | passaggio di consegne | przekazanie | předání |
| expert (tacit) knowledge | Expertenwissen | savoir-faire expert | conocimiento experto | conoscenza esperta | wiedza ekspercka | odborné znalosti |
| business process | Geschäftsprozess | processus métier | proceso de negocio | processo aziendale | proces biznesowy | obchodní proces |
| certify | zertifizieren | certifier | certificar | certificare | certyfikować | certifikovat |
| publish (button) | Veröffentlichen | Publier | Publicar | Pubblica | Opublikuj | Publikovat |
| actor types Human / Customer / Partner | Mensch / Kunde / Partner | Humain / Client / Partenaire | Persona / Cliente / Socio | Persona / Cliente / Partner | Człowiek / Klient / Partner | Člověk / Zákazník / Partner |
| "the OS" in a sentence | das OS | l'OS | el OS | l'OS | OS | OS |

## Wave 3 terms (Agents, Governance, Monitoring, Workflows)

| English | de | fr | es | it | pl | cs |
|---|---|---|---|---|---|---|
| grant (noun, a context/tool access right) | Berechtigung | autorisation | permiso | permesso | uprawnienie | oprávnění |
| grant (verb) | gewähren | accorder | conceder | concedere | nadać | udělit |
| builder stages Define · Grant · Design · Build · Run · Evaluate | Definieren · Gewähren · Entwerfen · Bauen · Ausführen · Bewerten | Définir · Accorder · Concevoir · Construire · Exécuter · Évaluer | Definir · Conceder · Diseñar · Construir · Ejecutar · Evaluar | Definisci · Concedi · Progetta · Costruisci · Esegui · Valuta | Zdefiniuj · Nadaj · Zaprojektuj · Zbuduj · Uruchom · Oceń | Definovat · Udělit · Navrhnout · Sestavit · Spustit · Vyhodnotit |
| ▶ Run (button) | ▶ Ausführen | ▶ Exécuter | ▶ Ejecutar | ▶ Esegui | ▶ Uruchom | ▶ Spustit |
| team (agent team) | Team | équipe | equipo | team | zespół | tým |
| capability | Fähigkeit | capacité | capacidad | capacità | możliwość | schopnost |
| output (a declared result) | Ausgabe | sortie | salida | output | wynik | výstup |
| trigger | Auslöser | déclencheur | activación | avvio | wyzwalacz | spouštěč |
| safety preset | Sicherheitsvorgabe | préréglage de sécurité | preajuste de seguridad | preimpostazione di sicurezza | ustawienie bezpieczeństwa | bezpečnostní předvolba |
| Read-only · Read + propose · Read + write | Nur lesen · Lesen + vorschlagen · Lesen + schreiben | Lecture seule · Lecture + proposition · Lecture + écriture | Solo lectura · Lectura + propuesta · Lectura + escritura | Sola lettura · Lettura + proposta · Lettura + scrittura | Tylko odczyt · Odczyt + propozycje · Odczyt + zapis | Jen čtení · Čtení + návrhy · Čtení + zápis |
| model tier Standard / Strong | Standard / Stark | Standard / Puissant | Estándar / Potente | Standard / Potente | Standardowy / Mocny | Standardní / Silný |
| checkpoint | Checkpoint | point de contrôle | punto de control | checkpoint | punkt kontrolny | kontrolní bod |
| trace (Langfuse) | Trace | trace | traza | traccia | ślad | stopa |
| canvas | Canvas | canevas | lienzo | canvas | kanwa | plátno |
| supervise / handoff (canvas edges) | beaufsichtigen / Übergabe | supervision / transmission | supervisión / traspaso | supervisione / passaggio | nadzór / przekazanie | dohled / předání |
| operating model | Betriebsmodell | modèle opérationnel | modelo operativo | modello operativo | model operacyjny | provozní model |
| Inbox (Governance) | Posteingang | Boîte de réception | Bandeja de entrada | Posta in arrivo | Skrzynka odbiorcza | Doručené |
| egress allowlist | Egress-Allowlist | liste de sortie autorisée | lista de salida permitida | allowlist di egress | lista dozwolonego ruchu wychodzącego | povolený odchozí provoz |
| capability profile | Berechtigungsprofil | profil de capacités | perfil de capacidades | profilo di capacità | profil uprawnień | profil schopností |
| standing policy | dauerhafte Richtlinie | politique permanente | política permanente | policy permanente | stała zasada | trvalá zásada |
| cost cap | Kostenlimit | plafond de coûts | tope de coste | tetto di spesa | limit kosztów | limit nákladů |
| audit log | Audit-Log | journal d'audit | registro de auditoría | log di audit | dziennik audytu | auditní log |
| security scan | Sicherheitsscan | analyse de sécurité | análisis de seguridad | scansione di sicurezza | skan bezpieczeństwa | bezpečnostní sken |
| mirror (git push mirror) | Spiegel | miroir | espejo | mirror | kopia lustrzana | zrcadlo |
| envelope (billing ceiling) | Budgetrahmen | enveloppe | presupuesto | budget | budżet | rozpočet |
| downstream | downstream | en aval | aguas abajo | a valle | niżej w łańcuchu | po proudu |
| lane (model lane) | Lane | couloir | carril | corsia | tor | dráha |
| asset (Dagster asset) | Asset | asset | asset | asset | zasób | položka |
| alert (firing) | Alarm | alerte | alerta | allarme | alert | upozornění |

"START" (the LangGraph entrypoint marker) and "END" stay as they are in every language.

## The 13 tabs and the sidebar groups

The tab label is keyed by the module's folder name (`shell.nav.tabs.<feature>`); the folder never changes.

| feature key | en | de | fr | es | it | pl | cs |
|---|---|---|---|---|---|---|---|
| home | Home | Start | Accueil | Inicio | Home | Start | Domů |
| data | Data | Daten | Données | Datos | Dati | Dane | Data |
| metrics | KPIs | KPIs | KPI | KPI | KPI | KPI | KPI |
| files | Files | Dateien | Fichiers | Archivos | File | Pliki | Soubory |
| knowledge | Knowledge | Wissen | Connaissances | Conocimiento | Conoscenza | Wiedza | Znalosti |
| workflows | Workflows | Workflows | Workflows | Flujos de trabajo | Workflow | Przepływy pracy | Workflowy |
| agents | Agents | Agenten | Agents | Agentes | Agenti | Agenci | Agenti |
| dashboards | Dashboards | Dashboards | Tableaux de bord | Paneles | Dashboard | Pulpity | Dashboardy |
| software | Software | Software | Logiciels | Software | Software | Oprogramowanie | Software |
| connections | Connections | Verbindungen | Connexions | Conexiones | Connessioni | Połączenia | Připojení |
| governance | Governance | Governance | Gouvernance | Gobernanza | Governance | Nadzór | Governance |
| monitoring | Monitoring | Monitoring | Supervision | Monitorización | Monitoraggio | Monitorowanie | Monitoring |
| admin | Platform | Plattform | Plateforme | Plataforma | Piattaforma | Platforma | Platforma |
| *group* Context | Context | Kontext | Contexte | Contexto | Contesto | Kontekst | Kontext |
| *group* Build | Build | Bauen | Créer | Crear | Crea | Tworzenie | Tvorba |
| *group* Manage | Manage | Verwalten | Gérer | Gestionar | Gestisci | Zarządzanie | Správa |

## Typography

- Quotation marks: de „…“, fr « … » (with spaces), es «…», it «…», pl „…”, cs „…“; en “…”.
- Ellipsis is the single character `…`. A dash in running text is an en dash with spaces in de (` – `), an em dash
  elsewhere, as the English source uses it.
- French puts a non-breaking space before `:`, `?`, `!`, `;` (`Domaine :`).
- Numbers, dates and money are never typed into a message: pass them as ICU arguments and format with
  `useFormat()` / `getFormat()` so each locale gets its own separators.
