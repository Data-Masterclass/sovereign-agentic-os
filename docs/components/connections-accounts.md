# Account connections in the Home chat (Notion, Microsoft 365, OneDrive, Google Drive)

Status: built 2026-11-24 for the dev user test. Owner decisions (23 Nov) are binding: per-user sign-in by
default, a shared credential only by an explicit warned tick (domain_admin for Domain, admin for Company),
users never sign in to LiteLLM, credentials encrypted and never in the OS database, permissive licences only.

## What a user and an admin see

- **Admin / domain admin**: Connections → *Accounts for the chat* → **＋ Add connection** → pick Notion,
  Microsoft 365, OneDrive or Google Drive → who can use it (My / My domain / The whole company) → sign-in
  mode (each person connects their own account; *Use ONE shared account* only behind a warning tick).
- **User**: the same panel lists every account connection they can see with *Connect your … account*,
  *Connected as you@…*, *Reconnect* and *Disconnect*. In the Home chat, a tool that needs their sign-in
  answers `needs_connect` and the chat shows a **Connect your … account** button under the answer; after
  consent the browser comes back to the chat (`returnTo`).

## Architecture chosen tonight — and the gateway path

**Built: per-user credentials in the OS vault, behind a `UserCredentialStore` interface that the LiteLLM MCP
gateway replaces.** (`tabs/connections/lib/user-credentials.ts`)

Why not the LiteLLM gateway tonight: the gateway needs (a) an MCP server registered in LiteLLM per
connection, (b) an OS-minted MCP-only per-user LiteLLM key and (c) seeding each user's token with
`POST /v1/mcp/server/{id}/oauth-user-credential`. (a) is a cluster write, which tonight's guardrails forbid,
and for Microsoft and Google there is no vendor MCP server we can register without tenant programmes (below).
The seam is one interface: `get / put / remove / has` for (connection, user). The gateway backend implements
`put` as the seeding call and `get` as "use my per-user key". The chat source, the routes, revoke and the
audit do not change.

### Which MCP server backs each connector (research, 2026-11-24)

| Connector | Tool source | Why |
|---|---|---|
| Notion | Notion's official remote MCP server `https://mcp.notion.com/mcp` (OAuth with DCR + PKCE S256, `resource` binding) | GA. Per-user OAuth works from a self-hosted client. [Notion: build an MCP client](https://developers.notion.com/guides/mcp/build-mcp-client.md), [get started](https://developers.notion.com/guides/mcp/get-started-with-mcp) |
| Microsoft 365 / OneDrive | The OS's own governed tools over **Microsoft Graph v1.0**, read-only | Microsoft's MCP for mail, files and Teams is **Work IQ MCP**. It needs admin-consented `WorkIQ.*` delegated scopes, a Global-Admin service principal and a Copilot-credits billing plan; the per-workload servers are still preview ([Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/mcp/overview), [permissions](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/permissions), [enable](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/enable-work-iq)). The *MCP Server for Enterprise* reaches only Entra directory data ([overview](https://learn.microsoft.com/en-us/graph/mcp-server/overview)). The local `@microsoft/workiq` server is under a Microsoft EULA, not a permissive licence. |
| Google Drive | The OS's own governed tools over **Google Drive v3**, read-only | Google's Workspace MCP servers (`drivemcp.googleapis.com` and others) are a **Developer Preview** behind enrolment ([configure MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers), [announcement](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html)). There is no official open-source server. |

No third-party server is deployed. To swap in Work IQ or Google's Workspace MCP later, change only
`account-tools.ts` (or route the connection through the gateway). The chat already speaks the MCP-shaped
port (`ExternalMcpSource`).

### Flow

```
Home chat ── loadExternalTools ──> account source (tabs/connections/lib/external-mcp-source.ts)
   │                                  │ resolveAccountSession(conn, user)   (store.ts)
   │                                  │   per_user → UserCredentialStore.get(conn, user)  — never another user's
   │                                  │   shared   → the connection's credential (owner connected it)
   │                                  │   legacy   → owner only
   │                                  │   refresh (serialised per conn+user), write back
   │                                  ├─ Notion → mcp.notion.com (tools/list, tools/call)
   │                                  └─ m365 / onedrive / gdrive → account-tools.ts → core/adapters/saas-http → Graph / Drive
   └─ every call: OPA os.external_mcp (credential_mode in the input) → read runs, write parks for confirmation
```

- **Credential storage**: one vault entry per (connection, user), ref `<connection secret>-u-<sha256(connection id, user)>`.
  The ref is derived, so revoke needs no index, and a connection deleted and re-created under the same name
  never inherits old sign-ins. The value lives only in `@core/infra/secrets`. **PR #334** makes that store
  durable and AES-256-GCM-encrypted in Kubernetes Secrets. This work uses only its public API
  (`putSecret / getSecretServerSide / deleteSecret / hasSecret`), so both PRs merge in either order. Until
  #334 is on dev, the vault is in-process: every os-ui restart forgets user sign-ins **and the OAuth
  app's client secret**.
- **OAuth**: the existing Microsoft/Google flow (`/api/connections/oauth/[provider]/…`) and the Notion flow
  (`/api/connections/notion/…`) now accept any user who can see a per-user connection. They ask for the
  template's own scopes (`scopesForTemplate`), carry a checked `returnTo` (`safeReturnTo`, same-origin
  paths only), and store through one sink (`completeAccountOAuth`): per-user goes to the caller's own
  credential, shared or legacy to the connection. One entry link for both UIs: `/api/connections/connect`.
- **Policy**: `external_mcp.rego` gains `credential_mode`. `per_user` and `shared` connections are usable
  by everyone who can see them. Legacy connections stay owner-only. An unknown mode stays owner-only.
  Archived connections are denied. Writes still park.
- **Revoke**: deactivating or offboarding a user (`/api/platform-admin/access/[id]`) calls
  `revokeUserAccountCredentials`. *Disconnect* removes only the caller's own entry.
- **Audit**: every chat call traces `actingUser`, `credentialMode` and `credentialSubject` (the account
  e-mail when known). Connect, disconnect, revoke and mode changes are traced too. Tokens never are.
- **Tools** (all read-only): Microsoft 365 has `mail_search`, `mail_get` (with a `provenance` block),
  `calendar_events`, `teams_chats`, `teams_chat_messages`, `teams_channels`, `teams_channel_messages`,
  `files_search` (OneDrive + SharePoint), `files_list` and `file_read`. OneDrive has the three file tools.
  Google Drive has `files_search`, `files_list` and `file_read` (Docs and Slides as text, Sheets and .xlsx
  as a table preview, .docx and text formats). Notion has its server's own tools.
- **Extract → write into the OS**: `save_knowledge_note` is offered up front whenever an account
  connection is in use, and the prompt tells the model to put a provenance frontmatter on the note. The
  new kernel tools are `preview_external_table` (free) and `import_external_table` (a write, so the confirm
  card shows). The import runs `create_dataset`, then `ingest_dataset` (the governed upload path, CSV ≤ 2 MB,
  cut on a row boundary and reported), then `document_dataset` with the source (connection, file, link,
  sheet, imported by/at). Everything lands in the user's own My scope. Excel is read without a dependency
  (`office-extract.ts`: zip + XML, zip-bomb bounded, header detection, date cells to ISO).

### Known gaps (honest)

- **Durability before #334**: in-process vault (see above). Merge #334 first, or tell testers to reconnect
  after any os-ui restart and expect the admin to re-enter the OAuth client secret.
- **PDF in the chat**: `file_read` does not convert PDFs. Sync the drive to Files (Docling) instead.
- **Google Sheets**: `file_read` previews only the first sheet (Google's CSV export). `import_external_table`
  exports the whole workbook as .xlsx and so honours `sheet`.
- **Gmail / Google Calendar** are not in this cut (`gmail.readonly` is a restricted scope that needs Google
  verification for external apps).
- **Teams channel messages** need `ChannelMessage.Read.All`, which requires admin consent in Entra.
- **Mutating routes** call `authorize()` as a recorded defense-in-depth decision (the platform-admin
  pattern). The role, scope and visibility refusals are enforced in the store, and OPA decides every chat call.

## Owner checklist (dev: `https://dev.agentic.datamasterclass.com`)

Never put a client id or secret in git or chat. Paste them only in the OS admin UI.

**Microsoft (Entra ID)** — needed for Microsoft 365 and OneDrive
1. Entra admin centre → App registrations → **New registration**: name `Sovereign OS (dev)`. Supported
   account types: **Accounts in any organizational directory (multi-tenant)**. The OS uses the `/common`
   endpoint, and a single-tenant app fails there with `AADSTS50194`.
2. Redirect URI, platform **Web**: `https://dev.agentic.datamasterclass.com/api/connections/oauth/microsoft/callback`
3. Certificates & secrets → **New client secret** → copy the *Value* once.
4. API permissions → Microsoft Graph → **Delegated**: `openid profile email offline_access User.Read Mail.Read
   Calendars.Read Files.Read Files.Read.All Sites.Read.All Chat.Read Team.ReadBasic.All Channel.ReadBasic.All
   ChannelMessage.Read.All` → **Grant admin consent for <tenant>**. `ChannelMessage.Read.All` needs it, and
   it saves every tester a consent prompt or a "needs admin approval" block.
5. OS → Platform → **OAuth apps** (`https://dev.agentic.datamasterclass.com/platform/oauth-apps`) → Microsoft →
   paste the Application (client) ID and the secret value → Save.

**Google (Cloud console)** — needed for Google Drive
1. APIs & Services → enable the **Google Drive API**.
2. OAuth consent screen: **Internal** if all testers are in your Workspace. Otherwise **External** in
   *Testing* mode with the testers added as test users (`drive.readonly` is a restricted scope).
   Add the scope `https://www.googleapis.com/auth/drive.readonly`.
3. Credentials → **Create OAuth client ID** → *Web application*. Authorised redirect URI:
   `https://dev.agentic.datamasterclass.com/api/connections/oauth/google/callback`
4. OS → Platform → **OAuth apps** → Google → paste the client ID and secret → Save.

**Notion** — nothing to register. The OS registers itself with Notion's MCP server per user (DCR). The
callback is `https://dev.agentic.datamasterclass.com/api/connections/notion/callback`. Each tester needs
a Notion member account, not a guest.

**Before the test**
- Merge #334 (durable encrypted secrets) together with these PRs, or re-enter the OAuth app secrets after
  every os-ui restart.
- As a domain admin: Connections → Accounts for the chat → add **Microsoft 365**, **OneDrive**, **Google
  Drive** and **Notion**, scope *My domain*, per-person sign-in.

## User test script (dev, Home chat)

Use two test users in the same domain (A and B) and one user in another domain (C).

1. **Admin setup (domain admin)**: Connections → *Accounts for the chat* → ＋ Add connection → Microsoft 365
   → *My domain* → Add. Repeat for OneDrive, Google Drive and Notion. Expected: four rows, each *each person
   signs in*, *Not connected*. Tick *Use ONE shared account*: a warning appears and *Add* stays disabled
   until the second tick. Cancel.
2. **Connect card (user A)**: Home → "What's in my inbox about budget?". Expected: a refused step and a
   **Connect your Microsoft 365 account** button. Click it, sign in with Microsoft and consent. You land
   back on Home.
3. **Outlook**: "Summarise my last 5 emails from <sender>". Expected: steps `m365__…__mail_search` and
   `mail_get`, and a summary. Connections shows *Connected as <your UPN>*.
4. **Email → knowledge**: "Summarise the last 5 emails from <sender> and save the key decisions as
   knowledge in /meetings". Expected: a confirm card for `save_knowledge_note`. Confirm. The note appears
   in Knowledge → My → /meetings, starting with a source block (message id, subject, date, Outlook link).
5. **Calendar / Teams / SharePoint**: "What meetings do I have this week?", "Show my recent Teams chats",
   "Find the Q4 deck on SharePoint". Expected: answers from `calendar_events`, `teams_chats` and
   `files_search`.
6. **Excel → dataset (OneDrive or SharePoint)**: "Take budget.xlsx from my OneDrive and create a dataset
   'Budget 2026'". Expected: `files_search`, then `preview_external_table` (the chat shows sheets, columns
   and row count and asks which sheet), then a confirm card for `import_external_table`. Confirm. Expected:
   the result names dataset *Budget 2026* in My data, its description names the file, sheet, link and
   you, and Data → My shows Bronze built.
7. **Google Drive**: "Connect" via the card if asked, then "Read my Google Doc 'Plan' and list the
   actions", then "Create a dataset from my Google Sheet 'Targets'".
8. **Notion**: "Search my Notion for Q3 plan". Connect via the card. Then "Copy the Q3 plan page into my
   knowledge". Expected: the preview list, then one confirm card.
9. **Isolation (user B)**: same domain, not connected. Ask "What's in my inbox?". Expected: B gets their
   **own** Connect card. B never sees A's mail. After B connects, B sees only B's mail.
10. **Isolation (user C, other domain)**: Connections shows none of the four. Asking the chat about
    Outlook does not offer the tools.
11. **Disconnect**: A → Connections → Disconnect on Microsoft 365 → ask about the inbox again. Expected:
    the Connect card again. B is still connected.
12. **Revoke**: admin deactivates B (Platform → Access). The audit detail says how many sign-ins were
    revoked. After reactivating, B must connect again.
13. **Writes park**: in Notion, "Create a page 'Test' in my workspace". Expected: a confirm card. Nothing
    is created until you confirm.
