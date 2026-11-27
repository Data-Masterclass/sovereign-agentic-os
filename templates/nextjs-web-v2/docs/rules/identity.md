# Identity and authorization: the OS decides

<!-- Owner: App Builder workstream E (the app identity token, spec section 8). -->

## Who the user is

- The user signs in to the **OS**, never to this app. The app never sees a password and holds no key, client secret
  or service identity of its own.
- Sign-in is platform-owned and already wired: `src/middleware.ts` sends a page request without a session to
  `/os/login`; `src/app/os/login` and `src/app/os/callback` run the OS sign-in (code flow with PKCE, `state`, `nonce`)
  through `src/lib/os/session.ts`. Do not change these files and do not add another login.
- The first sign-in shows an OS consent screen listing what the app may do as the user. When a deploy adds a granted
  dataset, agent or write action, the next sign-in asks again. The user can revoke the app in the OS under
  **My Settings → App permissions**; its next call as that user is refused.
- The result is an OS-issued **app identity token** (15 minutes) in a host-only `HttpOnly; Secure; SameSite=Lax`
  cookie. It is opaque to the app: never read, decode, log, store, or send it anywhere except through `src/lib/os`
  (which sends it to the OS as `Authorization: Bearer`). It never goes into a URL, a page, client JavaScript or git.
  When it expires the user is signed in again silently.

## What the app may do as the user

The token's scope is fixed by the OS, from what the app declares and was granted:

| Scope | Comes from | Lets the app |
|---|---|---|
| `read` | always | `os.whoami`, `os.context`, and read the datasets, KPIs and files **granted to the app** by id; `os.records` reads when an action in `actions.yml` declares the `records` scope |
| `agent-run` | the app has agent grants | `os.agents.run` / `os.agents.get` for the granted agent systems only |
| `action:<name>` | each `write: true` action in `actions.yml` | the writes that action declares (for `records`: `os.records.add/update/remove/export`) |

There is no generic write, no approval and no admin scope, ever. Approving a parked agent run happens in the OS, not
in the app. Lists that are not limited to the app's grants (all datasets, all knowledge) are not available to the
token: read your granted items from `os.context()`.

## Authorization

- Do NOT write your own authorization: no role comparisons, no `isAdmin`, no JWT or cookie parsing, no allow-lists
  of users. The OS re-reads the user's role and domains on **every** call and checks it with OPA; a user who was
  demoted or deactivated loses access at once, even with a token that has not expired.
- Get identity from `src/lib/os` (`asCaller`, `requireUser`). A refusal arrives as `Forbidden` (403) or
  `NotAuthenticated` (401): pass it on, never turn it into a success.
- Background work as the app itself is not available until a domain admin approves an app identity.

## Configuration (set by the platform)

`OS_PUBLIC_URL` (the browser's way to the OS), `OS_BASE_URL` (the in-cluster way), `APP_DOMAIN`, `APP_SLUG`,
`APP_ENV` (`dev` or `prod`). The OS accepts sign-in only for this app's registered hosts: the Prod host, and in Dev
the Dev host and the two preview slots. Never invent another variable or host.
