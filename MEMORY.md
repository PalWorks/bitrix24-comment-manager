# Memory: Architectural Decisions and Persistent Context

This document captures architectural decisions, tradeoffs, known constraints, and assumptions that govern the codebase. Read this to understand why things are the way they are, not just how they work.

## Architectural Decisions

### AD-0: Runtime Configured Backend over a Compiled-In URL

**Decision:** The extension ships with no backend address in the bundle. Each
installation stores its own in `chrome.storage.local`, set from the options page.
`VITE_BACKEND_URL` remains as an optional build time seed for distributors who
want a pre-configured build.

**Rationale:** A compiled-in URL means every adopter must fork, edit, and rebuild,
and it makes a single Chrome Web Store listing impossible. The blocker used to be
the `connect-src` in the manifest CSP. Manifest V3's default extension_pages
policy carries no `connect-src` at all, so removing ours lets the page reach any
origin; the actual gate becomes CORS, which the backend already configures
through `CORS_ORIGINS`.

**Tradeoff:** A first run now needs a configuration step. The setup view in the
popup keeps that to one field.

### AD-0b: Runtime Portal Registration over an Enumerated Domain List

**Decision:** `*.bitrix24.com` stays a static content script match. Every other
portal, regional domain, custom domain, or self hosted, is added by the user at
runtime through `optional_host_permissions` plus
`chrome.scripting.registerContentScripts`.

**Rationale:** Bitrix24 publishes no authoritative list of its regional domains,
and match patterns cannot wildcard a TLD. Guessing a list into the manifest would
be both incomplete and stale, and would request broad host access up front.
Asking once, per portal, is honest about what is being granted.

**Tradeoff:** Users outside `bitrix24.com` have one extra setup step. The
registry re-registers on startup and prunes portals whose permission was revoked.

### AD-1: Stateless JWT over Server-Side Sessions

**Decision:** Use short-lived JWTs (1 hour) with a JTI blacklist instead of server-side sessions.

**Rationale:** The backend must be deployable as a single-process server. Server-side sessions require sticky sessions or a shared session store (Redis). JWTs are verified using a shared secret, allowing any instance to validate any request. The JTI blacklist is an acceptable tradeoff because it only tracks recently-refreshed/logged-out tokens, keeping memory usage bounded.

**Tradeoff:** The JTI blacklist is in-memory (per-process). If the instance restarts, blacklisted tokens become valid again until they expire naturally. At 1-hour expiry, the exposure window is small. The same applies across instances: a token blacklisted on one is still accepted by another. This is why the documented deployment is a single instance.

### AD-2: Service Worker as Sole API Gateway

**Decision:** All backend API calls from the extension go through the service worker via `chrome.runtime.sendMessage`. The popup and options page never call `fetch` for authenticated endpoints.

**Rationale:** Manifest V3 runs the service worker in an isolated context. Centralizing API calls in the service worker ensures: (a) the JWT is stored in one place, (b) token refresh is handled transparently, (c) the popup does not need direct backend access (simplifying CSP).

**Exception:** The popup's offline connectivity check calls `GET /health` directly because it is unauthenticated and does not require JWT handling.

### AD-3: Fire-and-Forget Audit Logging

**Decision:** `writeAuditLog()` is called without `await` in route handlers. The HTTP response is returned immediately.

**Rationale:** Audit log writes should never block user-facing latency. If the database is slow, the agent should still get a fast response. Failed writes are logged to stderr and tracked in `pendingWrites` for graceful shutdown draining.

**Tradeoff:** If the process crashes between the HTTP response and the audit write completing, the log entry is lost. This is acceptable because the comment operation itself succeeded in Bitrix24 and can be reconciled.

### AD-3b: Bitrix24 Tokens Persisted and Encrypted

**Decision:** Bitrix24 access and refresh tokens are stored in MySQL, encrypted
with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`, with a process cache in front.

**Rationale:** They previously lived only in a Map, so every restart, deploy, or
watchdog respawn silently logged out every agent. That is unacceptable for a tool
people use all day. A refresh token is valid for 180 days, which makes it exactly
the kind of credential that should not sit in a database in plaintext.

**Tradeoff:** Production now requires a second secret, and losing it invalidates
every session. The backend refuses to start without it rather than quietly
falling back to plaintext.

### AD-3c: JWT in chrome.storage.session

**Decision:** The extension's JWT is held in `chrome.storage.session` rather than
a service worker module variable.

**Rationale:** Manifest V3 terminates an idle service worker after roughly thirty
seconds, taking module state and timers with it. Holding the token in memory
alone logged the agent out repeatedly during normal use. Session storage is
memory backed rather than written to disk, is cleared when the browser closes,
and is not exposed to content scripts, so it keeps the previous security
properties while surviving the restart.

**Tradeoff:** The token API became asynchronous, which rippled through auth,
apiClient, and the message router.

### AD-4: In-Memory Rate Limiting

**Decision:** Rate limiting uses in-memory Maps (`agentWindows`, `ipWindows`) instead of Redis or a database.

**Rationale:** The documented deployment is a single Node process. At the expected agent count (<200), in-memory Maps are simpler, faster, and have no external dependency. Periodic pruning (60s) prevents unbounded growth.

**Tradeoff:** Rate limits are per-instance, not global. An agent hitting different instances can theoretically exceed the intended limit by the number of instances. At current scale, this is negligible.

### AD-5: Bitrix24 Request Queuing with Backoff

**Decision:** `bitrix24Client.ts` implements a request queue with exponential backoff when Bitrix24 returns HTTP 429.

**Rationale:** Bitrix24 enforces its own rate limits. Without queuing, burst traffic from multiple agents would result in dropped requests. The queue serializes retries with increasing delays, ensuring eventual completion.

### AD-5b: Retention Purge Exempted from the Immutability Trigger

**Decision:** The audit `BEFORE DELETE` trigger permits a delete only while the
session variable `@audit_log_retention_purge` is set, which the retention
procedure sets around its own statement.

**Rationale:** The immutability trigger and the retention policy were in direct
contradiction: the trigger blocked every delete, so the scheduled purge could
never succeed. One of the two had to give, and a documented, narrowly scoped
exception is better than either silently broken retention or an audit log anyone
can delete from.

**Tradeoff:** Someone with SQL access can set the variable themselves. They could
also drop the trigger, so this does not lower the ceiling. The trigger defends
against application bugs and casual tampering, not against a database
administrator.

### AD-6: SHA-256 Comment Hashing for Dedup and Privacy

**Decision:** Comment bodies are hashed (SHA-256) before storage in the audit log. The raw text is never persisted.

**Rationale:** The audit log is a compliance and debugging tool. Storing raw comment text creates data privacy liability. The hash allows duplicate detection without retaining the original content.

### AD-7: Content Script URL Parsing over DOM Inspection

**Decision:** Lead detection uses URL regex matching, not DOM element inspection.

**Rationale:** Bitrix24's SPA UI changes across versions. URL patterns are stable. Regex is fast, synchronous, and does not depend on DOMContentLoaded timing. The pattern (`/crm/lead/details/<id>/`) has remained consistent across observed Bitrix24 versions.

**Tradeoff:** If Bitrix24 changes its URL structure, the regex must be updated. This is surfaced clearly in `CONFIG.LEAD_PATH_PATTERN` in `constants.ts`. The pattern is matched against the URL's pathname rather than the whole URL, so portals served under a path prefix are detected too.

### AD-8: Server-Side OAuth2 Callback

**Decision:** The backend handles the Bitrix24 OAuth2 redirect (at `GET /auth/callback`) rather than the extension.

**Rationale:** Bitrix24 validates the redirect URI against the registered handler. The `chromiumapp.org` URL produced by `chrome.identity.launchWebAuthFlow` is not accepted by Bitrix24 as a valid redirect URI. By routing the redirect through the backend (`https://api.example.com/auth/callback`), the domain matches the registered handler, and the flow completes successfully. The extension polls `GET /auth/poll?state=` to retrieve the JWT once the backend has stored it.

**Tradeoff:** Adds a polling round-trip and an in-memory `pendingSessions` store on the backend. The store has a 10-minute TTL, after which unresolved sessions are discarded.

## Known Constraints

1. **No SSR/CSR in the extension.** The popup and options page are static HTML with TypeScript entry points compiled by Vite. No React, Vue, or framework overhead.

2. **No WebSocket or Server-Sent Events.** Communication is request/response only. The popup polls `/health` for connectivity but does not maintain a persistent connection.

3. **No offline comment queuing.** If the backend is unreachable, the user sees the offline banner. Comments cannot be queued and submitted later. This was a deliberate scope decision.

4. **Single portal support.** The extension connects to one Bitrix24 portal at a time (configured via `BITRIX24_PORTAL_DOMAIN`). Multi-portal support would require refactoring the token store to be keyed by domain.

5. **50-entry activity log cap.** The `queryActivityLog` function enforces a maximum of 50 results per query. This is hardcoded in `auditLogger.ts`.

## Assumptions

1. The reference deployment runs Node.js 20 behind a reverse proxy, supervised by a process manager.
2. The MySQL database is reachable from the backend, typically on the same host.
3. Bitrix24 OAuth2 application credentials are provisioned by the portal administrator.
4. Agents use Google Chrome. The OAuth2 flow opens a small popup window (`chrome.windows.create`) and polls the backend for the JWT.
5. The extension is distributed via the Chrome Web Store (or sideloaded for development).
6. All Bitrix24 portal URLs follow the pattern `https://<subdomain>.bitrix24.com`.
