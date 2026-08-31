# Changelog

All notable changes to the Bitrix24 Comment Manager are documented in this file. Entries are ordered from newest to oldest.

## [2.0.0] Open Source Release

The project is now portable: any Bitrix24 team can run it, against any portal,
without editing the source. Existing single portal deployments keep working with
no configuration change.

### Breaking

- **New required secret.** `TOKEN_ENCRYPTION_KEY` (64 hex characters, generate
  with `openssl rand -hex 32`) is required in production. The backend refuses to
  start without it rather than storing Bitrix24 tokens in plaintext.
- **Two new migrations**, `006_add_portal_domain.sql` and
  `007_create_bitrix_tokens.sql`. Apply both before deploying.
- **Re-run `004` and `005`.** Both are now idempotent and must be re-applied to
  fix the retention conflict described below.
- **Voice input removed.** It was disabled in the popup and advertised in the
  README. See below.
- `BITRIX24_PORTAL_DOMAIN` is no longer required on its own; either it or
  `BITRIX24_ALLOWED_PORTALS` must be set. Existing deployments that set it are
  unaffected.

### Added

- **Runtime configuration.** The backend URL is set from the options page and
  stored per installation. One build now serves every deployment.
  `VITE_BACKEND_URL` remains as an optional build time default.
- **Multi portal support.** `BITRIX24_ALLOWED_PORTALS` accepts a comma separated
  list with `*.suffix` wildcards, so one backend can serve several portals.
  `GET /auth/login` takes a `portal` parameter, validated against that allowlist.
- **Portals beyond bitrix24.com.** Regional domains, custom domains, and self
  hosted installations are added from the options page, which requests the host
  permission and registers a content script at runtime.
- **Durable Bitrix24 tokens.** Persisted to MySQL, encrypted with AES-256-GCM.
- `portal_domain` recorded on every audit entry.
- OAuth state is bound to the portal the login started for, so a state issued
  for one allowed portal cannot be completed against another.
- Community documentation: `docs/SETUP.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull request templates, MIT `LICENSE`.

### Fixed

- **The retention purge could never run.** Migration 004's `BEFORE DELETE`
  trigger blocked every delete on `comment_audit_log`, including the purge that
  migration 005 schedules. The trigger now permits deletes only from within the
  retention procedure.
- **Migration 005 failed on MySQL.** It used `CREATE INDEX IF NOT EXISTS`, which
  MySQL does not support. The index was redundant with one from migration 003 and
  has been removed.
- **Agents were logged out whenever the service worker idled out.** The JWT was
  held in a module variable, which Manifest V3 discards when it terminates an
  idle worker. It now lives in `chrome.storage.session` and the refresh schedule
  is reinstated on startup.
- **Every backend restart de-authenticated every agent.** Bitrix24 tokens were
  held only in memory. See the persistence change above.
- **Failed authorizations were not audited.** Only a failed token exchange
  produced an `AUTH_FAILURE` entry; a missing parameter, a replayed state, and a
  disallowed portal did not. All four are audited now.
- **Lead detection missed portals served under a path prefix.** The URL pattern
  is matched against the pathname rather than the whole URL.
- **The test suite was red.** Thirteen tests were failing against the previous
  release. The suite is green at 274 tests, up from 203, with new coverage for
  settings, the portal registry, encryption, the token store, and the portal
  allowlist.

### Changed

- CSP no longer pins `connect-src`. Manifest V3's default carries no such
  directive, and pinning it hard coded a single deployment's hostname into every
  build.
- The popup and options page no longer load fonts from a CDN.
- CI consolidated to a single workflow with one job, running on pull requests and
  pushes to `main` only. The unused Cloud Run deployment workflow was removed.
- The corrected description of backend state and scaling replaces an inaccurate
  comment in `config.ts` that claimed the backend held no in-process state.

### Removed

- **Voice input.** The Web Speech API integration was unconditionally hidden in
  the popup because of CSP and permission prompt problems, while the README
  listed it as a headline feature. The module, the button, its test, and the
  associated `google.com` CSP entries are gone. It remains in git history.
- Dead `agents` and `agent_mappings` migrations. Neither table was referenced by
  any code.
- Cloud Run deployment documentation and workflow, which did not match how the
  project is actually deployed.

## [1.1.0] Deployment and OAuth Rewrite

### MySQL Migration (commit 7f1cf73)

- Migrated database driver from `pg` (PostgreSQL) to `mysql2`.
- Updated `DATABASE_URL` format to `mysql://user:pass@host:3306/db`.
- Rewrote all migration SQL files for MySQL syntax (`AUTO_INCREMENT`, `DATETIME`, `CURRENT_TIMESTAMP`).
- Updated `auditLogger.ts` and readiness checks for `mysql2` query API.
- Updated all unit and integration tests to mock `mysql2` instead of `pg`.

### Shared Hosting Deployment (commit e420b32 context)

- Set up Node.js 20 via NVM and PM2 on shared hosting.
- Created PHP reverse proxy (`deploy/php-proxy/proxy.php`) to forward HTTPS traffic from `api.example.com` to Node.js on port 3001.
- Created `.htaccess` to route all API subdomain requests through the proxy.
- Configured TLS for `api.example.com`.
- Backend confirmed live at `https://api.example.com/health`.

### OAuth Flow Rewrite: Server-Side Callback (commit e746b01)

**Backend:**
- `GET /auth/login` now returns `{ authUrl, state }` using `https://api.example.com/auth/callback` as `redirect_uri` (accepted by Bitrix24).
- Added `GET /auth/callback`: handles Bitrix24 redirect, exchanges code for tokens, stores JWT in `pendingSessions` map keyed by state (10-minute TTL).
- Added `GET /auth/poll?state=`: extension polls this until JWT is available.

**Extension:**
- Replaced `chrome.identity.launchWebAuthFlow` with `chrome.windows.create({ type: 'popup' })` + polling loop.
- Removed `identity` permission from `manifest.json`.
- `VITE_BACKEND_URL` set via root `.env` file read by Vite's `envDir: '..'`.

### UX Improvements (commit 6fc8426)

- Auth flow now opens a small floating popup window (520x680) instead of a new tab, keeping the user on the Bitrix24 page throughout.
- `navigationWatcher.ts`: added `history.pushState` and `replaceState` interception so the extension detects Bitrix24 SPA navigation immediately without requiring a page refresh.

### Self-Healing Proxy and PM2 Watchdog (commits d3ca08a)

- `proxy.php` upgraded with self-healing logic: detects `CURLE_COULDNT_CONNECT`, calls `shell_exec` to restart PM2, waits 5 seconds, and retries the request.
- `scripts/start-b24-backend.sh`: PM2 watchdog registered as an hPanel cron job (every 5 minutes).
- Added `DEPLOYMENT.md` with the full development and deployment pipeline.

### Documentation Updates (this session)

- Updated `README.md`: MySQL stack, deployment section, new OAuth API table, corrected tech stack and prerequisites.
- Updated `ARCHITECTURE.md`: MySQL references, runtime, server-side OAuth flow, mysql2 pool.
- Updated `DATA_MODEL.md`: MySQL schema syntax, `mysql` CLI migration command.
- Updated `MEMORY.md`: replaced Cloud Run and GCP assumptions with a PM2 process, updated AD-8 to document server-side OAuth decision.

## [1.0.0] Production Release


### Final Remediations (commit 5067aec)

**Security:**
- Stripped `http://localhost:3000` from the Content Security Policy in production extension builds via `build-extension.sh`.

**Reliability:**
- Added 30-second `AbortController` timeout to all backend `fetch` calls in `apiClient.ts` and `tokenManager.ts`.
- Added promise guard mutex in `tokenManager.ts` to prevent concurrent token refresh network calls.

**Performance:**
- Added periodic pruning (every 60s) of expired rate limiter Map entries in `rateLimiter.ts`.
- Wired `stopPruneTimer()` into the graceful shutdown sequence in `server.ts`.

**User Experience:**
- Added offline feedback banner to the popup UI. Pings `/health` every 15 seconds with a 5-second timeout and displays an orange "Backend unreachable" banner when connectivity is lost.

**Tests:**
- Added `tests/unit/extension/apiClient.test.ts` (6 tests: success, signal passing, API error, network error, timeout, no token).
- Updated `tests/unit/backend/rateLimiter.test.ts` with pruning cleanup and idempotency test.

### Phase 8: Deployment Infrastructure (commit 7110ee6)

- Created `backend/Dockerfile` with multi-stage build (node:20-alpine, non-root user).
- Created `.github/workflows/ci.yml` (lint, typecheck, test, build on push/PR).
- Created `.github/workflows/deploy.yml` (Docker build, GCR push, Cloud Run deploy with health check verification).
- Created `scripts/build-extension.sh` (production build with CSP injection, zip bundling, size validation).
- Created deployment documentation: `docs/deployment/cloud-run.md`, `chrome-web-store.md`, `secrets.md`, `monitoring.md`.
- Created `docs/operations/runbook.md` for production troubleshooting.

### Phases 3 to 5: Comments, Audit, Options, Voice (commit 666bba7)

**Backend:**
- Added `routes/comments.ts` with full CRUD (create, edit, delete) for timeline comments.
- Added `middleware/commentValidator.ts` with body validation, length limits, and SHA-256 duplicate detection.
- Added `middleware/leadAuth.ts` for lead-level authorization via Bitrix24 API.
- Added `services/bitrix24Client.ts` with request queuing and exponential backoff for Bitrix24 rate limits.
- Added `services/auditLogger.ts` with fire-and-forget PostgreSQL logging, pending write tracking, and graceful drain.
- Added `models/auditLog.ts` with typed `AuditLogEntry` and `ActivityLogRow` interfaces.
- Added `routes/activity.ts` for agent activity log queries.
- Added `utils/hash.ts` for SHA-256 comment hashing.

**Extension:**
- Built popup UI with comment form (textarea, voice button, submit), comment list with edit/delete actions, character counter, and loading states.
- Added `popup/voiceInput.ts` with Web Speech API integration for voice to text transcription.
- Built options page with agent info display and paginated activity log.
- Added `COMMENT_CREATE`, `COMMENT_EDIT`, `COMMENT_DELETE`, `GET_LEAD_INFO`, `GET_ACTIVITY_LOG` message handlers to `messageRouter.ts`.

### Phase 2: Lead Detection (commit 1f412e3)

- Added `content/content.ts` as the content script entry point injected into `*.bitrix24.com` pages.
- Added `content/urlParser.ts` with regex-based lead ID extraction from Bitrix24 URLs.
- Added `content/navigationWatcher.ts` with throttled monitoring for SPA navigation events.
- Added `background/leadState.ts` for per-tab lead ID tracking.
- Added `LEAD_DETECTED`, `LEAD_NOT_DETECTED`, `GET_LEAD_STATE` message handlers to `messageRouter.ts`.
- Added lead context display to the popup UI (lead ID, name, detecting/found/not-found states).

### Phase 1: Authentication (commit e759638)

**Backend:**
- Added `services/tokenService.ts` with JWT signing/verification, Bitrix24 token storage, OAuth state management, and JTI blacklist with expiry-based cleanup.
- Added `middleware/jwtAuth.ts` for Bearer token verification and `req.user` injection.
- Added `middleware/agentAuth.ts` for agent-level authorization (verifies stored Bitrix24 tokens).
- Added `middleware/rateLimiter.ts` with sliding window rate limiting (per-agent and per-IP).
- Added `routes/auth.ts` with `GET /auth/login` (OAuth URL generation), `POST /auth/callback` (code exchange), `POST /auth/logout` (token cleanup), and `POST /auth/refresh` (JWT renewal).

**Extension:**
- Added `background/tokenManager.ts` with in-memory JWT storage and automatic refresh scheduling (5 minutes before expiry).
- Added `background/apiClient.ts` as a fetch wrapper with JWT injection.
- Added `background/auth.ts` with OAuth2 flow via `chrome.identity.launchWebAuthFlow`.
- Added `background/messageRouter.ts` with typed message dispatch for `AUTH_LOGIN`, `AUTH_LOGOUT`, `AUTH_STATUS`.
- Implemented `background/service-worker.ts` entry point with `chrome.runtime.onMessage` listener.
- Built popup UI with three-state layout: loading, logged out (connect button), and logged in (agent info + lead context).

### Phase 0: Project Setup (commit 0e20986)

- Initialized npm workspaces monorepo with `backend/` and `extension/` packages.
- Configured TypeScript (strict mode, `tsconfig.base.json` with project references).
- Configured Vite with CRXJS plugin for Chrome extension development.
- Configured ESLint and Prettier for code quality.
- Created `manifest.json` (Manifest V3) with permissions, CSP, and content script registration.
- Created `vitest.config.ts` with jsdom environment for extension tests and custom JS-to-TS resolver.
- Set up Express server skeleton with Helmet, CORS, health/readiness endpoints, and graceful shutdown.
- Created `backend/src/config.ts` with environment variable loading and validation.
- Created typed error hierarchy in `backend/src/utils/errors.ts` (8 error subclasses).
- Created structured JSON logger in `backend/src/utils/logger.ts`.
