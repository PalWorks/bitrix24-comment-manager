# Agent Behavior Contract

This file defines the rules, constraints, and conventions that any AI agent or LLM-driven automation must follow when working on this codebase. This is the single most important file for LLM workflows.

## Agent Roles

| Role | Scope | Description |
|---|---|---|
| Feature Developer | Extension + Backend | Implements new user-facing features end to end |
| Bug Fixer | Any module | Diagnoses and fixes reported issues |
| Reviewer | Any module | Audits code for correctness, security, and convention adherence |
| Test Writer | `tests/` | Writes unit, integration, and E2E tests |
| Doc Writer | `docs/`, root `.md` files | Creates and updates documentation |

## Coding Conventions

### General Rules
- TypeScript strict mode. No `any` except in test mocks.
- No `console.log` or `console.error` in production code. Use `logger` (backend) or remove entirely (extension).
- No dashes, double dashes, triple dashes, em-dashes in any text, documentation, or code comments.
- Write modular, human-readable code. Functions should do one thing.
- All exported functions must have JSDoc comments with a description of behavior.
- Use `snake_case` for database columns and API JSON fields. Use `camelCase` for TypeScript variables and functions.
- Numeric separators for large constants: `60_000`, not `60000`.
- `as const` for constant object literals.
- No default exports. Use named exports everywhere.

### Extension Specific
- All API calls from the popup/options/content must go through `chrome.runtime.sendMessage` to the service worker. Never call `fetch` from the popup for backend API endpoints.
- The one exception: the popup's connectivity check may call `fetch` directly to `/health` because it is unauthenticated and the service worker does not need to mediate it.
- New message types must be added to `shared/constants.ts` `MESSAGE_TYPES`, handled in `background/messageRouter.ts`, and typed in `shared/types.ts`.
- Popup state is ephemeral. Store nothing in `localStorage` or `sessionStorage`. All persistent state lives in the service worker's in-memory variables.

### Backend Specific
- All new routes must be added to the appropriate router in `routes/` and registered in `server.ts`.
- Middleware ordering matters: `jwtAuth → agentAuth → leadAuth → rateLimiter → commentValidator → handler`. Do not reorder.
- Errors must use the typed error hierarchy in `utils/errors.ts`. Never throw raw `Error` objects in route handlers.
- Audit logging is mandatory for all comment operations and auth failures. Call `writeAuditLog()` without `await` (fire and forget).
- New environment variables must be added to `config.ts` with `requireEnv()` or `optionalEnv()`.

## Restricted Areas

These areas are high-risk and require extra caution:

| Area | File(s) | Why |
|---|---|---|
| Auth flow | `routes/auth.ts`, `tokenService.ts`, `auth.ts` (ext) | Security critical. Token exchange, JWT signing, OAuth state. |
| JWT middleware | `middleware/jwtAuth.ts` | Bypass could expose all endpoints. |
| Audit logger | `services/auditLogger.ts`, `models/auditLog.ts` | Compliance critical. Changes affect audit trail integrity. |
| Graceful shutdown | `server.ts` (lines 118-133) | Incorrect ordering can lose data or leak connections. |
| Build script CSP | `scripts/build-extension.sh` (lines 34-38) | CSP misconfiguration opens security vulnerabilities. |
| Manifest permissions | `extension/manifest.json` | Changing permissions requires a full Chrome Web Store review. |

## Allowed Actions

- Modify any file not listed in Restricted Areas without special caution.
- Add new test files to `tests/unit/`, `tests/integration/`, `tests/e2e/`.
- Add new route handlers, middleware, services, or utility functions.
- Add new message types following the convention in MESSAGE_TYPES.
- Update CSS styles in popup/options.
- Add new documentation files.

## Review Rules

Before considering any change complete:

1. **Type check passes**: `npm run typecheck` must exit 0.
2. **Lint passes**: `npm run lint` must exit 0.
3. **Full test suite passes**: `npm test` must pass all tests with 0 failures.
4. **No regressions**: The test count must not decrease unless tests were intentionally removed (with justification).
5. **New code is tested**: Any new function or branch must have corresponding unit tests.
6. **Restricted area changes**: Must include a self-review rationale explaining why the change is safe.

## Safety Constraints

- Never store raw comment text in audit logs. Only store the SHA-256 hash via `hash.ts`.
- Never log JWT tokens, Bitrix24 access tokens, or client secrets.
- Never disable or weaken the CSP in `manifest.json`.
- Never remove `helmet()` or CORS configuration from `server.ts`.
- Never change the middleware execution order without a documented reason.
- Never use `setTimeout` or `setInterval` without `.unref()` on the backend and without cleanup on shutdown.
- Never introduce synchronous blocking operations in route handlers.
- Never commit `.env` files or hardcoded secrets.

## Error Handling Pattern

```typescript
// Backend: use typed errors
import { BadRequestError } from '../utils/errors.js';
throw new BadRequestError('Lead ID is required.');

// Extension: return structured results
return { success: false, error: { code: 'TIMEOUT', message: 'Request timed out.' } };
```

## File Naming Conventions

| Type | Convention | Example |
|---|---|---|
| Route handler | `<resource>.ts` | `comments.ts`, `leads.ts` |
| Middleware | `<purpose>.ts` | `jwtAuth.ts`, `rateLimiter.ts` |
| Service | `<domain>Service.ts` or `<domain>Client.ts` | `tokenService.ts`, `bitrix24Client.ts` |
| Extension module | `<feature>.ts` | `tokenManager.ts`, `leadState.ts` |
| Test file | `<module>.test.ts` | `rateLimiter.test.ts`, `apiClient.test.ts` |
| Shared type | `types.ts`, `messages.ts` | Centralized, one per category |
