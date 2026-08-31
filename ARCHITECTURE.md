# Architecture

## System Overview

Bitrix24 Comment Manager is a two-component system: a Chrome Extension (MV3) and a Node.js backend API. The extension provides the user interface for CRM agents. The backend authenticates agents, enforces business rules, proxies operations to the Bitrix24 REST API, and records audit logs in MySQL.

The two components are loosely coupled. The extension knows nothing about Bitrix24 REST endpoints. The backend knows nothing about the Chrome extension internals. They communicate exclusively over HTTPS with JWT authentication.

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                                      │
│                                                                      │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────────────┐ │
│  │ Content      │    │ Service      │    │  Popup / Options UI      │ │
│  │ Script       │───>│ Worker       │<───│  (popup.ts, options.ts)  │ │
│  │ (content.ts) │    │ (background) │    │                          │ │
│  └─────────────┘    └──────┬───────┘    └──────────────────────────┘ │
│                            │                                         │
│                            │ chrome.runtime.sendMessage              │
│                            ▼                                         │
│                     ┌──────────────┐                                  │
│                     │ apiClient.ts │───── fetch + JWT ──────┐        │
│                     └──────────────┘                        │        │
└─────────────────────────────────────────────────────────────┼────────┘
                                                              │ HTTPS
                                                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Backend API (Express on Node 20, behind a reverse proxy)            │
│                                                                      │
│  Request Pipeline:                                                   │
│  Helmet → CORS → JSON Parser → Route Handler                        │
│                                                                      │
│  Auth Routes (/auth/*)        API Routes (/api/*)                    │
│  ┌─────────────┐              ┌─────────────────────┐                │
│  │ IP Rate     │              │ JWT Auth             │                │
│  │ Limiter     │              │ Agent Auth           │                │
│  │ OAuth Flow  │              │ Lead Auth (comments) │                │
│  └─────────────┘              │ Agent Rate Limiter   │                │
│                               │ Comment Validator    │                │
│                               └─────────┬───────────┘                │
│                                         │                            │
│                                         ▼                            │
│  ┌─────────────────┐    ┌───────────────────────┐    ┌────────────┐ │
│  │ tokenService.ts  │    │ bitrix24Client.ts      │    │ auditLog   │ │
│  │ JWT + Bitrix     │    │ Bitrix24 REST proxy    │───>│ MySQL      │ │
│  │ token management │    │ with request queuing   │    │            │ │
│  └─────────────────┘    └───────────────────────┘    └────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS (Bitrix24 REST)
                                    ▼
                          ┌──────────────────┐
                          │ Bitrix24 CRM     │
                          │ REST API         │
                          └──────────────────┘
```

## Data Flow: Comment Creation

This is the most complex flow and involves all components:

1. **Content script** detects a lead URL via regex and sends `LEAD_DETECTED` with the lead ID to the service worker.
2. **Service worker** stores the lead ID in the per-tab `leadState` map.
3. **Popup** opens, calls `AUTH_STATUS` (sync) and `GET_LEAD_STATE` (async via `chrome.tabs.query`) to render the UI.
4. **Popup** fetches lead info via `GET_LEAD_INFO`, which calls `GET /api/leads/:leadId` on the backend.
5. **User** types or dictates a comment and clicks Submit.
6. **Popup** sends `COMMENT_CREATE { leadId, body }` to the service worker.
7. **Service worker** calls `apiClient.apiRequest('POST /api/comments', { lead_id, comment_body })` with the JWT.
8. **Backend middleware chain** executes: jwtAuth → agentAuth → leadAuth → rateLimiter → commentValidator.
9. **Comment route handler** calls `bitrix24Client.addTimelineComment(leadId, body)`.
10. **bitrix24Client** queues the request (exponential backoff on 429s) and calls the Bitrix24 REST API.
11. **Route handler** fires `writeAuditLog()` (non-blocking) and returns the result.
12. **Response** propagates back: backend → apiClient → service worker → popup → UI update.

## Service Boundaries

| Boundary | Protocol | Auth Mechanism | Timeout |
|---|---|---|---|
| Popup/Content to Service Worker | `chrome.runtime.sendMessage` | Same extension origin | None (Chrome manages) |
| Service Worker to Backend | HTTPS `fetch` | `Authorization: Bearer <JWT>` | 30s AbortController |
| Backend to Bitrix24 REST | HTTPS `fetch` | `?auth=<bitrix_access_token>` | Request queue with backoff |
| Backend to MySQL | TCP (mysql2 pool) | `DATABASE_URL` connection string | mysql2 pool defaults |

## Extension Module Responsibilities

| Module | File(s) | Role |
|---|---|---|
| Content Script | `content/content.ts`, `urlParser.ts`, `navigationWatcher.ts` | Detect lead pages, notify service worker |
| Service Worker | `background/service-worker.ts`, `messageRouter.ts` | Central message dispatch, lifecycle |
| Auth | `background/auth.ts` | Server-side OAuth2 flow: opens popup window, polls `/auth/poll` for JWT |
| Token Manager | `background/tokenManager.ts` | JWT storage, refresh scheduling, concurrent refresh guard |
| API Client | `background/apiClient.ts` | Fetch wrapper with JWT injection and timeout |
| Settings | `shared/settings.ts` | Backend URL and portal list, validation |
| Portal Registry | `background/portalRegistry.ts` | Host permissions and dynamic content script registration for portals outside *.bitrix24.com |
| Lead State | `background/leadState.ts` | Per-tab lead ID tracking |
| Popup | `popup/popup.ts`, `popup.html`, `popup.css` | Comment UI, connectivity monitor |
| Options | `options/options.ts`, `options.html`, `options.css` | Session info, activity log |
| Shared | `shared/constants.ts`, `types.ts`, `messages.ts` | Config, interfaces, message factory |

## Backend Module Responsibilities

| Module | File(s) | Role |
|---|---|---|
| Config | `config.ts` | Environment variable loading and validation |
| Server | `server.ts` | Express setup, middleware chain, graceful shutdown |
| JWT Auth | `middleware/jwtAuth.ts` | JWT verification, `req.user` injection |
| Agent Auth | `middleware/agentAuth.ts` | Agent-level authorization |
| Lead Auth | `middleware/leadAuth.ts` | Lead ownership verification via Bitrix24 |
| Rate Limiter | `middleware/rateLimiter.ts` | Sliding window (per-agent + per-IP) with auto-pruning |
| Comment Validator | `middleware/commentValidator.ts` | Body validation, length, duplicate detection |
| Auth Routes | `routes/auth.ts` | Login (OAuth URL), callback (code exchange), refresh, logout |
| Comment Routes | `routes/comments.ts` | CRUD endpoints for timeline comments |
| Leads Route | `routes/leads.ts` | Lead info proxy |
| Activity Route | `routes/activity.ts` | Agent activity log query |
| Token Service | `services/tokenService.ts` | JWT issuance, Bitrix token store, JTI blacklist, OAuth state |
| Bitrix24 Client | `services/bitrix24Client.ts` | REST API client with request queuing and backoff |
| Token Store | `services/tokenStore.ts` | Bitrix24 tokens persisted to MySQL, encrypted, with a process cache |
| Crypto | `utils/crypto.ts` | AES-256-GCM for credentials at rest |
| Audit Logger | `services/auditLogger.ts` | Fire-and-forget MySQL logging with drain |
| Error Hierarchy | `utils/errors.ts` | Typed error classes (8 subclasses of `AppError`) |
| Logger | `utils/logger.ts` | Structured JSON logger |
| Hash | `utils/hash.ts` | SHA-256 for comment dedup |

## Scaling Considerations

The backend is designed as a **stateless** HTTP service. Multiple instances can run behind a load balancer with no sticky sessions. JWT verification uses a shared secret, not server-side sessions.

**Current limitations (in-memory stores):**

- `bitrixTokenStore`, `jtiBlacklist`, `oauthStateStore` in `tokenService.ts`
- `agentWindows`, `ipWindows` in `rateLimiter.ts`

These Maps are per-process. Under the documented single-instance deployment, this is fine. For horizontal scaling with persistent state across instances, these should migrate to Redis. This is documented in the roadmap.

## Graceful Shutdown Sequence

```
SIGTERM/SIGINT received
    → stopCleanupTimers()     (tokenService prune timers)
    → stopPruneTimer()        (rateLimiter prune timer)
    → server.close()          (stop accepting new connections)
        → drainPendingWrites() (wait for in-flight audit log writes)
        → shutdownPool()       (close MySQL connections)
        → process.exit(0)
```
