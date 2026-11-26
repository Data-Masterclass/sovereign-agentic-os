# Account connections in the Home chat (Notion, Microsoft 365, OneDrive, Google Drive)

Status: built 2026-11-24 for the dev user test. Owner decisions (23 Nov) are binding: per-user sign-in by
default, a shared credential only by an explicit warned tick (domain_admin for Domain, admin for Company),
users never sign in to LiteLLM, credentials encrypted and never in the OS database, permissive licences only.

## What a user and an admin see

- **Admin / domain admin**: Connections → *Accounts for the chat* → **＋ Add connection** → pick Notion,
  Microsoft 365, OneDrive or Google Drive → who can use it (My or My domain) → sign-in mode. Each person
  connects their own account. *Use ONE shared account* is offered only for a Domain connection, behind a
  warning tick. *The whole company* is shown greyed out. A Company connection is visible only in its home
  domain until company scope (#333) ships, so the UI does not offer it yet; the API still allows it for
  admins.
- **User**: the same panel lists every account connection they can see with *Connect your … account*,
  *Connected as you@…*, *Reconnect* and *Disconnect*. In the Home chat, a tool that needs their sign-in
  answers `needs_connect` and the chat shows a **Connect your … account** button under the answer; after
  consent the browser comes back to the chat (`returnTo`).
- **Sign-in app missing** (Microsoft 365 / OneDrive need the Microsoft app, Google Drive the Google app, both
  registered at Connections → *Sign-in apps (Google & Microsoft)*, URL `/platform/oauth-apps`): the row shows
  a warning, *Can't connect yet: the Microsoft sign-in app isn't set up.*, instead of a Connect button. An
  admin gets a **Set up the sign-in app** button; anyone else is told to ask their admin (the page is
  admin-only). The add form warns before adding and says *Added. Next step: set up the … sign-in app*
  after. `GET /api/connections/accounts` returns `signInApps: {google, microsoft}` (booleans only, never a
  client id or secret). Wording: `tabs/connections/lib/sign-in-apps.ts`.

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
| Microsoft 365 / OneDrive | The OS's own governed tools over **Microsoft Graph v1.0**, read-only (Microsoft 365: plus approval-gated mail draft/send behind an admin switch) | Microsoft's MCP for mail, files and Teams is **Work IQ MCP**. It needs admin-consented `WorkIQ.*` delegated scopes, a Global-Admin service principal and a Copilot-credits billing plan; the per-workload servers are still preview ([Work IQ MCP overview](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/mcp/overview), [permissions](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/permissions), [enable](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/work-iq/enable-work-iq)). The *MCP Server for Enterprise* reaches only Entra directory data ([overview](https://learn.microsoft.com/en-us/graph/mcp-server/overview)). The local `@microsoft/workiq` server is under a Microsoft EULA, not a permissive licence. |
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
  A connection deleted and re-created under the same name never inherits old sign-ins. A small
  per-connection index of user ids (no secret) sits beside the entries. The value lives only in
  `@core/infra/secrets`, which since #334 is durable and AES-256-GCM-encrypted in Kubernetes Secrets.
  Storing a sign-in, a refresh write-back, a disconnect and a revoke all await the durable write
  (`awaitSecretWrites`) before reporting success.
- **Refresh**: refreshes are serialised per (connection, user) within one process. Across processes,
  the write-back uses the store's conditional write (#334 `'adopt'`): if another pod stored a newer
  token set in the meantime, that one wins. This matters for Notion's rotating refresh tokens. A store
  failure during write-back is reported as its own error, never as "your sign-in expired".
- **OAuth**: the existing Microsoft/Google flow (`/api/connections/oauth/[provider]/…`) and the Notion flow
  (`/api/connections/notion/…`) now accept any user who can see a per-user connection. They ask for the
  template's own scopes (`scopesForTemplate`) and carry a `returnTo` limited to an allowlist (`/`, `/home`,
  `/connections`, `/unstructured`, `/files`; the query is dropped). Everything is stored through one sink,
  `completeAccountOAuth`, which **re-checks at the callback** that the caller may still connect, in case
  the mode, scope or archive state changed during consent. Per-user sign-ins go to the caller's own
  credential; shared or legacy ones go to the connection. One entry link for both UIs:
  `/api/connections/connect`.
- **Policy**: `external_mcp.rego` gains `credential_mode`. `per_user` and `shared` connections are usable
  by everyone who can see them. Legacy and unknown modes stay owner-only. `shared` on a Personal connection
  is denied (`shared_credential_not_allowed`). Archived connections are denied. Writes still park.
- **Shared never widens silently**: `shared` is refused on a My connection. Any promote or demote
  (My → Domain → Company and back) resets `shared` to `per_user` until someone with the new scope's role
  re-confirms with the warned tick.
- **Revoke**: `deactivateUser` and `offboardUser` (`tabs/admin`) call the kernel registry
  `revokeUserEverywhere` (`core/kernel/user-revocation.ts`). The Connections tab registers its revoke there
  at boot (`instrumentation.ts`), so every path that deactivates revokes: the Access page, offboarding and
  domain delete. A failed revoke is raised. Deleting a connection purges every user's sign-in.
  *Disconnect* removes only the caller's own entry.
- **Provider revocation** happens after the OS has deleted its copy, best-effort, and the outcome is
  audited. **Google**: RFC 7009 `oauth2.googleapis.com/revoke` with the refresh token, which revokes the
  grant. **Microsoft**: there is no per-token revocation endpoint for delegated tokens, so the OS only
  deletes the refresh token; an Entra admin can revoke the user's sessions. **Notion**: no revocation
  endpoint is documented for MCP clients, so the OS only deletes the token; a workspace admin can remove
  the client.
- **Audit**: one shape for the whole OS, `ConnectionAttribution` (`core/infra/connection-attribution.ts`,
  #337), at the top level of every trace event: `actingUser`, `credentialMode` (`per_user` / `shared` /
  `owner`), `credentialSubject` (the signed-in account for per-user, otherwise the owner) and
  `connectionId`. The kernel's `callExternal` is the single trace point for every chat call; the source
  returns `credentialSubject` on the result. The one account read that bypasses it (the spreadsheet read
  behind the table tools) writes exactly one trace with the same attribution, redacted. Connect,
  disconnect, revoke, provider revoke and mode changes carry the same top-level attribution. Tokens never
  appear in any trace.
- **Tools** (read-only unless noted): Microsoft 365 has `mail_search`, `mail_get` (with a `provenance` block),
  `calendar_events`, `teams_chats`, `teams_chat_messages`, `teams_channels`, `teams_channel_messages`,
  `files_search` (OneDrive + SharePoint), `files_list` and `file_read` — plus the two mail writes
  `mail_draft` and `mail_send` when the connection allows them (next section). OneDrive has the three file
  tools. Google Drive has `files_search`, `files_list` and `file_read` (Docs and Slides as text, Sheets and
  .xlsx as a table preview, .docx and text formats). Notion has its server's own tools.

### Outlook: draft and send mail (Microsoft 365, admin switch, default off)

This is the OS's one Outlook connector. The pasted-token `outlook` template is retired (2026-11-26); a stored
connection that still names it is refused with a plain reason by Test, by every tool call and by data-usage,
never answered by the offline mock.

- **The switch**: *Allow drafting and sending mail* on a Microsoft 365 account connection (Connections →
  Accounts for the chat, in the add form and on the row). Default **off**. Turning it on needs a domain admin,
  or an administrator for a Company connection, and edit rights on the connection; turning it off needs only
  edit rights. It needs per-user sign-in: mail is always sent as the signed-in person, never through one
  shared mailbox. API: `PATCH /api/connections/{id}/account {"allowMailSend": true|false}`, or
  `allowMailSend` on `POST /api/connections/accounts`. Every change is audited (`set_mail_send`).
  Once the switch is on (add form and row), a note under it says it requires Mail.ReadWrite and Mail.Send in
  the Entra app registration, with a link to Sign-in apps (Google & Microsoft). That page lists the Microsoft scopes in
  two groups: *Always needed* (the read set) and *Only needed if you turn on 'Allow drafting and sending
  mail' on a Microsoft 365 connection* (Mail.ReadWrite, Mail.Send).
- **Who still has to reconnect**: with the switch on, the row shows admins and domain admins who may change
  the switch "N people connected without send permission" (`mailSendRow` / `mailSendUngrantedCount` in the
  store: per-user sign-ins whose stored granted scopes lack the two mail scopes). Only the count, never who,
  and nothing for anyone else; 0 shows no hint.
- **Who gets it**: a My connection is visible to its owner only, and only a domain admin or an administrator
  can switch mail on. So a creator gets drafting and sending through a **Domain** (or Company) Microsoft 365
  connection on which a domain admin (administrator) turned the switch on, each person with their own sign-in.
- **The switch never travels**: it is turned **off**, and the change audited (`set_mail_send` with `because`),
  whenever the connection's audience or credential changes: promotion (My → Domain → Company), demotion, a
  domain move, and leaving per-user sign-in (a shared credential). It does not come back by itself:
  re-enabling at the new scope needs that scope's authority.
- **Scopes**: only when the switch is on does the authorize request for that connection add the delegated
  `Mail.ReadWrite` (a draft is a message in the user's own Drafts) and `Mail.Send`
  (`core/auth/providers.ts`, `accountAuthorizeConfig` in the store). Off: the request is the read set above.
- **Tools** (`tabs/connections/lib/account-tools.ts`), both `readOnly: false`, so OPA answers
  `requires_approval` and the confirm card parks them; they run only on the confirm-execute path, where OPA
  is asked again with `confirmed`. The Graph v1.0 requests:

  | | New mail (no `replyToMessageId`) | Reply (`replyToMessageId`) |
  |---|---|---|
  | `mail_draft` | `POST /me/messages` (body `contentType: Text`) → draft id + `webLink` | 1. `POST /me/messages/{id}/createReply` with **no body** (Exchange builds the reply with the quoted original) → 2. `PATCH /me/messages/{draftId}` → draft id + `webLink` |
  | `mail_send` | `POST /me/sendMail` (body `contentType: Text`, `saveToSentItems: true`) | steps 1 and 2, then 3. `POST /me/messages/{draftId}/send` |

  The PATCH sets `toRecipients` and `ccRecipients` to **exactly** the lists on the confirm card (replacing
  what Exchange filled in; an empty Cc clears it) and the body to `contentType: HTML`: our text with the five
  HTML specials escaped (`& < > " '`), line breaks as `<br>`, in a `<div>` whose inline style is
  `white-space:pre-wrap` (spaces and tabs keep the layout the card showed) plus `display`, `visibility` and
  `opacity` with `!important`, so a stylesheet in the quoted original cannot simply hide it. It is ALWAYS placed
  at the very top of the document, before the quoted original, which is left exactly as Exchange made it: the
  OS never parses or searches the original's HTML (`replyHtml`), so a `<body>` an external sender hides in a
  comment, a style, a script, a template or an attribute has nothing to capture, and the work is linear in the
  size of the original. Model-written markup such as `<a href=…>` arrives as visible text, never a live link.
  **Accepted residual**: a hostile stylesheet in the quoted original could still hide the text by other means
  (font size, colour, positioning). That is the same exposure as a reply typed in Outlook itself on that thread.
  **Size cap**: a quoted original over 3 MB (`REPLY_ORIGINAL_MAX`) is refused before the PATCH with `too_large`
  ("reply to this thread in Outlook itself"); the reply draft is removed and nothing is sent. Graph refuses
  request bodies over about 4 MB, so such a reply could not be sent from the chat anyway.
  If the PATCH fails, the orphan reply draft is deleted (best effort) and the answer says whether that worked.
  If the final send fails with a refusal, the prepared reply stays in Drafts and the answer says so.

  Inputs: `to[]`, `cc[]` (optional), `subject` (a new mail only; a reply keeps the thread's subject, so a
  subject on a reply is refused rather than silently dropped), `body` (plain text), `replyToMessageId`.
  Checked locally before any request (`validateMailInput`): at least one To; recipients deduplicated
  case-insensitively across To and Cc (an address in To is dropped from Cc), then at most 10; plain ASCII
  addresses only (no display names); a body of at most 20 000 characters; a one-line subject of at most 255;
  Bcc, HTML and attachments are refused. A refusal is `invalid_request` with the reason, and nothing is
  parked or sent. **Not supported yet**: internationalised (non-ASCII) addresses such as `jörg@exämple.de`
  are refused as invalid.
- **Before the card** (`ExternalMcpSource.precheck`, kernel `core/runtime/external-mcp.ts`): the input check
  and the caller's own grant. A call that cannot run is not parked: the user is never asked to confirm a dead
  call. For a reply it also reads the original's subject and sender (`GET /me/messages/{id}`, a read with the
  caller's own token) and hands them to the card as display-only context (never stored as an argument, never
  executed); a reply to a message that does not exist is refused here. The input and grant checks run again
  at the write itself.
- **The confirm card** shows the whole message as text: for a reply the thread it goes to (original subject
  and sender) - the sender by its address; a display name that contains `@`, `<` or `>`, or a look-alike of
  them (fullwidth and small forms, caught after NFKC, and angle-bracket look-alikes), is not shown; Unicode bidi
  and format controls (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F, U+061C) are dropped from the subject and
  sender and "The original message is quoted below your text."; To, Cc, Subject (or "the thread's
  subject") and the full body, uncut (`mailPreviewOf` in `core/ui/chat-view.ts`, rendered by
  `core/ui/ConfirmCard.tsx`). The recipients and body are the stored arguments the confirmation runs with.
- **Whose credential**: the caller's own per-user sign-in only (`resolveAccountSession`), never another
  user's and never a fallback. The grant must hold both scopes: the token response's `scope` is stored with
  the sign-in (`TokenSet.scope`, kept across refreshes) and read as `AccountSession.grantedScopes`.
  A sign-in made before the switch was turned on answers `needs_connect` and the chat shows **Reconnect to
  allow sending**; the Connections row says the same (`AccountStatus.mailSendGranted`).
- **Honest failures** (`mailFailure` in `account-tools.ts`); nothing is retried, so a mail never goes twice:

  | Graph answers | The chat says |
  |---|---|
  | 403 `Authorization_RequestDenied`, or `ErrorAccessDenied` whose message speaks of a permission/scope | `needs_connect`: Reconnect to allow sending |
  | any other 403 (mailbox or transport rule, send-as restriction, …) | `no_access`: "Microsoft refused to send this mail: <code>". No reconnect loop; ask the Microsoft 365 administrator |
  | 429 | `rate_limited`, with the service's Retry-After |
  | timeout, lost connection, 5xx | `outcome_unknown`: it is not known whether the mail was sent / drafted; check Sent Items and Drafts before trying again |
  | other 4xx | `tool_error`, saying nothing was sent (or that the reply stays in Drafts) |

  Only the vendor's error **code** of a 403 and whether its message names a permission are kept
  (`core/adapters/saas-http/client.ts`); the message text is never echoed. The 403 body is read at most 8 KB and only
  within the request's own timeout, so a slow or endless error body cannot hold the turn.
- **Audit**: the one trace of the call (`callExternal`) carries the usual attribution (`actingUser`,
  `credentialMode: per_user`, `credentialSubject` = the signed-in UPN) and, for a write, `output.action`,
  `output.mode` (`new` / `reply`), `output.recipients` and `output.sentAs` (the UPN). Never a token; the
  audit summary is not shown to the model.
- **Extract → write into the OS**: `save_knowledge_note` is offered up front whenever an account
  connection is in use, and the prompt tells the model to put a provenance frontmatter on the note. The
  new kernel tools are `preview_external_table` (free) and `import_external_table` (a write, so the confirm
  card shows). The import runs `create_dataset`, then `ingest_dataset` (the governed upload path, CSV ≤ 2 MB,
  cut on a row boundary and reported), then `document_dataset` with the source (connection, file, link,
  sheet, imported by/at). Everything lands in the user's own My scope. Excel is read without a dependency
  (`office-extract.ts`: zip + XML read by a linear `indexOf` scanner, with no lazy regular expressions).
  Hostile files are bounded: zip offsets are checked, inflated parts are capped (zip bomb), rows and
  columns are clamped to Excel's 1,048,576 × 16,384 and stored sparsely, the table may hold at most
  2,000,000 cells, and each parse has a 5 s time budget. Every refusal is an `OfficeExtractError`.

### Known gaps (honest)

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
4. API permissions → Microsoft Graph → **Delegated**: `offline_access User.Read Mail.Read Calendars.Read
   Files.Read Files.Read.All Sites.Read.All Chat.Read Team.ReadBasic.All Channel.ReadBasic.All
   ChannelMessage.Read.All` → **Grant admin consent for <tenant>**. The set is deliberate and read-only.
   `User.Read` covers "Connected as" (Graph `/me`), so `openid profile email` are not requested.
   `ChannelMessage.Read.All` needs admin consent; granting consent up front also saves every tester a
   consent prompt or a "needs admin approval" block.
   **Only if a Microsoft 365 connection will allow drafting and sending mail:** also add the delegated
   `Mail.ReadWrite` and `Mail.Send` permissions and **Grant admin consent** again. The OS asks for them only
   on a connection whose switch is on; without the switch they are never requested.
5. OS → Connections → **Sign-in apps (Google & Microsoft)** (`https://dev.agentic.datamasterclass.com/platform/oauth-apps`) → Microsoft →
   paste the Application (client) ID and the secret value → Save.

**Google (Cloud console)** — needed for Google Drive
1. APIs & Services → enable the **Google Drive API**.
2. OAuth consent screen: **Internal** if all testers are in your Workspace. Otherwise **External** in
   *Testing* mode with the testers added as test users (`drive.readonly` is a restricted scope).
   Add the scope `https://www.googleapis.com/auth/drive.readonly`.
3. Credentials → **Create OAuth client ID** → *Web application*. Authorised redirect URI:
   `https://dev.agentic.datamasterclass.com/api/connections/oauth/google/callback`
4. OS → Connections → **Sign-in apps (Google & Microsoft)** → Google → paste the client ID and secret → Save.

**Notion** — nothing to register. The OS registers itself with Notion's MCP server per user (DCR). The
callback is `https://dev.agentic.datamasterclass.com/api/connections/notion/callback`. Each tester needs
a Notion member account, not a guest.

**Before the test**
- #334 (durable encrypted secrets) is merged, so sign-ins and OAuth app secrets survive an os-ui restart.
- As a domain admin: Connections → Accounts for the chat → add **Microsoft 365**, **OneDrive**, **Google
  Drive** and **Notion**, scope *My domain*, per-person sign-in.

## User test script (dev, Home chat)

Use two test users in the same domain (A and B) and one user in another domain (C).

1. **Admin setup (domain admin)**: Connections → *Accounts for the chat* → ＋ Add connection → Microsoft 365
   → *My domain* → Add. *The whole company* is greyed out until company scope ships. Repeat for OneDrive, Google Drive and Notion. Expected: four rows, each *each person
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
12. **Revoke**: admin deactivates B (Platform → Access). B's sign-ins are revoked; Google also revokes the
    grant at Google. After reactivating, B must connect again. Deleting a connection removes everyone's
    sign-in on it.
13. **Writes park**: in Notion, "Create a page 'Test' in my workspace". Expected: a confirm card. Nothing
    is created until you confirm.

### Outlook draft and send (dev)

Prerequisite: the Entra app has `Mail.ReadWrite` + `Mail.Send` with admin consent (owner checklist, step 4).
Use user A (connected before the switch) and a domain admin.

- **R0 — off by default**: Connections → the Microsoft 365 row shows no *can draft and send mail* badge. As
  A, "Draft a mail to me saying hello". Expected: no `mail_draft` step; the assistant says it cannot draft.
- **R1 — switch on**: as the domain admin, tick *Allow drafting and sending mail* on the row (a creator does
  not see the tick). The badge appears, with the Entra note and its link to Sign-in apps (Google & Microsoft). Once A
  has signed in without the mail permissions, the row shows the admin "1 person connected without send
  permission"; a creator sees no count.
- **R2 — reconnect**: as A (connected before R1), "Draft a mail to <A's own address>, subject Test, saying
  hello". Expected: no confirm card; a refused step and a **Reconnect to allow sending** button; the
  Connections row says *your sign-in does not allow sending yet*. Click it, consent to the two mail
  permissions, land back on Home.
- **R3 — draft to self**: ask again. Expected: a confirm card with To, Subject and the full body as text.
  Cancel → nothing in Outlook Drafts. Ask again → Run → the answer gives the draft's Outlook link, and the
  draft is in Drafts, unsent.
- **R4 — send to self**: "Send a mail to <A's own address>, subject Send test, body: line one / line two".
  Expected: the card shows both lines; Run → the mail arrives; Sent Items has it. Monitoring shows the
  `m365.mail_send` trace with *sent as* A's address.
- **R5 — reply**: "Reply to the Send test mail: thanks, received". Expected: `mail_search` finds it, the card
  names the thread (its subject and sender), says the original is quoted below, Subject "the thread's
  subject"; Run → the reply is in the same conversation, your text at the very top above the quote, line
  breaks as typed,
  and only the recipients the card showed. Try a body with `<b>bold</b>`: it arrives as visible text.
- **R6 — limits**: "Send a mail to 11 people …" or to `not-an-address`. Expected: a refused step with the
  plain reason; no card, nothing sent.
- **R7 — another user**: user B (connected, never reconnected) asks to send. Expected: B gets *Reconnect to
  allow sending*; B can never send through A's sign-in.
- **R8 — switch off hides the tools**: the domain admin unticks the switch. As A, ask to draft again.
  Expected: no `mail_draft` / `mail_send` step and no card; reading mail still works.
- **R9 — the switch does not travel**: turn it on for a My test connection (as the domain admin), promote it
  to the domain. Expected: the switch is off again on the row until someone re-ticks it.
