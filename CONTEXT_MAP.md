# Context Map

This document maps common tasks to the exact files you need to read and modify. Use this to skip the exploration phase and go directly to the relevant code.

## Task to File Mapping

### Authentication Changes

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Change the OAuth2 flow | `routes/auth.ts`, `tokenService.ts` | `routes/auth.ts`, `tokenService.ts` |
| Change JWT claims or expiry | `tokenService.ts`, `config.ts` | `tokenService.ts`, `config.ts` |
| Change the extension login flow | `background/auth.ts`, `tokenManager.ts` | `background/auth.ts`, `tokenManager.ts` |
| Change token refresh behavior | `tokenManager.ts` (ext), `routes/auth.ts` (backend) | Both files |
| Add new JWT claims | `tokenService.ts`, `jwtAuth.ts`, `shared/types.ts` | All three |

### Comment Operations

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Add a new comment endpoint | `routes/comments.ts`, `commentValidator.ts`, `bitrix24Client.ts` | `routes/comments.ts`, `bitrix24Client.ts` |
| Change comment validation rules | `commentValidator.ts`, `config.ts` | `commentValidator.ts` |
| Change duplicate detection | `commentValidator.ts`, `utils/hash.ts`, `auditLogger.ts` | `commentValidator.ts` |
| Add comment UI features | `popup/popup.ts`, `popup.html`, `popup.css` | All three |
| Wire a new comment action from popup to backend | `shared/constants.ts`, `shared/types.ts`, `background/messageRouter.ts`, `popup/popup.ts`, `routes/comments.ts` | All five |

### Lead Detection

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Change the lead URL pattern | `shared/constants.ts` (CONFIG.LEAD_URL_PATTERN) | `shared/constants.ts` |
| Change lead detection behavior | `content/content.ts`, `content/urlParser.ts`, `content/navigationWatcher.ts` | Relevant content script file |
| Change lead state management | `background/leadState.ts`, `background/messageRouter.ts` | Both |
| Add lead info display | `popup/popup.ts`, `routes/leads.ts`, `bitrix24Client.ts` | Relevant files |

### Rate Limiting

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Change rate limit thresholds | `routes/auth.ts` (IP limiter), route registrations (agent limiter) | The file where the limiter is instantiated |
| Change pruning behavior | `middleware/rateLimiter.ts` | `middleware/rateLimiter.ts` |
| Add a new rate limiter type | `middleware/rateLimiter.ts` | `middleware/rateLimiter.ts`, the route using it |

### Audit Logging

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Change what is logged | `models/auditLog.ts`, `services/auditLogger.ts` | Both + the route handler calling `writeAuditLog` |
| Change the audit log schema | `models/auditLog.ts`, `auditLogger.ts` INSERT_SQL | Both + migration SQL |
| Query the activity log | `services/auditLogger.ts` (ACTIVITY_SQL), `routes/activity.ts` | Relevant file |

### UI Changes

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Popup layout or styling | `popup/popup.html`, `popup/popup.css` | Both |
| Popup behavior or state | `popup/popup.ts`, `shared/constants.ts` | `popup/popup.ts` |
| Options page | `options/options.html`, `options/options.css`, `options/options.ts` | All three |

### Configuration

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Add a backend env var | `backend/src/config.ts` | `config.ts`, `.github/workflows/deploy.yml`, `README.md` |
| Add an extension build-time var | `extension/vite.config.ts`, `extension/env.d.ts` | Both |
| Change CSP | `extension/manifest.json`, `scripts/build-extension.sh` | Both |
| Change CORS | `backend/src/server.ts`, `backend/src/config.ts` | Both |

### Testing

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Add backend unit tests | Existing tests in `tests/unit/backend/` for patterns | New file in `tests/unit/backend/` |
| Add extension unit tests | Existing tests in `tests/unit/extension/` for patterns | New file in `tests/unit/extension/` |
| Add integration tests | Existing tests in `tests/integration/` for patterns | New file in `tests/integration/` |
| Change test config | `vitest.config.ts` | `vitest.config.ts` |

### Deployment

| When you need to... | Read these files | Modify these files |
|---|---|---|
| Change CI pipeline | `.github/workflows/ci.yml` | `ci.yml` |
| Change deploy pipeline | `.github/workflows/deploy.yml` | `deploy.yml` |
| Change Docker image | `backend/Dockerfile` | `backend/Dockerfile` |
| Change extension build | `scripts/build-extension.sh` | `build-extension.sh` |

## Error Handling Chain

When something goes wrong, errors flow through these layers:

```
Bitrix24 API error
    → bitrix24Client.ts throws BitrixApiError
        → route handler catches, calls writeAuditLog({ status: 'FAILED' })
            → Express error handler in server.ts catches AppError
                → Sends JSON { error: { code, message } }
                    → apiClient.ts (extension) extracts error
                        → messageRouter.ts sendResponse({ success: false, error })
                            → popup.ts displays error in UI
```

## Shared Types Flow

```
extension/shared/types.ts
    ├── Used by popup/popup.ts (UI rendering)
    ├── Used by background/messageRouter.ts (payload types)
    ├── Used by background/apiClient.ts (ApiResult generic)
    └── Mirrors backend response shapes

extension/shared/constants.ts
    ├── MESSAGE_TYPES → used by every module that sends/receives messages
    ├── CONFIG → used by content script (URL pattern), popup (char limit), apiClient (timeout)
    └── BACKEND_URL → used by apiClient.ts, popup.ts (health check)

extension/shared/messages.ts
    ├── ExtensionMessage<T> → typed message envelope
    └── createMessage() → factory function used by popup and content script
```
