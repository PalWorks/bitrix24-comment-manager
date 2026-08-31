# Domain Knowledge

This document explains the business logic, entities, terminology, and rules that govern the Bitrix24 Comment Manager system. Agents must read this before making changes that touch business logic.

## Business Context

Bitrix24 is a CRM (Customer Relationship Management) platform. Organizations use it to manage sales leads, customer contacts, deals, and communications. Each lead record has a timeline where agents can post comments visible to the team.

This extension exists because the native Bitrix24 comment workflow requires navigating deep into the CRM interface. Agents working in high-volume call centers need a faster, keyboard-accessible way to add comments without leaving the lead page.

## Core Entities

### Lead
A prospective customer record in Bitrix24 CRM.

| Property | Type | Source | Example |
|---|---|---|---|
| Lead ID | Numeric string | URL and Bitrix24 API | `"12345"` |
| Lead Name | String | Bitrix24 API (`crm.lead.get`) | `"John Smith"` |
| URL Pattern | Regex | Content script detection | `https://portal.bitrix24.com/crm/lead/details/12345/` |

Leads are identified by parsing the browser URL. The regex pattern is defined in `CONFIG.LEAD_URL_PATTERN` and matches URLs of the form `https://<portal>/crm/lead/details/<id>/`.

### Timeline Comment
A text entry attached to a lead's activity timeline in Bitrix24.

| Property | Type | Source |
|---|---|---|
| Comment ID | Numeric string | Returned by Bitrix24 after creation |
| Comment Body | String (max 5000 chars) | User input via popup textarea or voice |
| Comment Hash | SHA-256 hex string | Computed server-side from comment body |

Comments are created via `crm.timeline.comment.add`, edited via `crm.timeline.comment.update`, and deleted via `crm.timeline.comment.delete`. These are Bitrix24 REST API methods.

### Agent
A Bitrix24 user who operates the Chrome extension. Agents authenticate via OAuth2 and receive a JWT for subsequent API calls.

| Property | Type | Source |
|---|---|---|
| Member ID | String | OAuth2 `member_id` claim from Bitrix24 |
| Domain | String | Portal domain (e.g. `company.bitrix24.com`) |
| Bitrix User ID | String | From the OAuth2 token exchange response |
| Client Endpoint | String | API endpoint URL for the specific portal |

### Audit Log Entry
A record of every comment operation performed through the system.

| Field | Type | Purpose |
|---|---|---|
| `agent_id` | String | Maps to the JWT `memberId` |
| `bitrix_user_id` | String or null | The Bitrix24 user ID (from stored tokens) |
| `lead_id` | String | The lead that was acted upon |
| `comment_id` | String or null | The Bitrix24 comment ID (null for failed creates) |
| `action_type` | Enum | `CREATE`, `EDIT`, `DELETE`, `AUTH_FAILURE` |
| `comment_hash` | String | SHA-256 of the comment body (never raw text) |
| `timestamp` | ISO 8601 string | When the action occurred |
| `ip_address` | String or null | Client IP from `req.ip` |
| `status` | Enum | `SUCCESS` or `FAILED` |
| `failure_reason` | String or null | Error message if failed |

## Business Rules

### Authentication
1. Agents must authenticate via the Bitrix24 OAuth2 flow before any API operations.
2. The backend issues a short-lived JWT (default 1 hour) containing `memberId`, `domain`, and `clientEndpoint`.
3. JWTs are refreshed automatically 5 minutes before expiry. The refresh endpoint issues a new JWT and blacklists the old one's JTI.
4. On logout, the JWT's JTI is blacklisted and the stored Bitrix24 tokens are removed.

### Authorization
1. Only authenticated agents can access `/api/*` endpoints.
2. The `agentAuth` middleware verifies the agent has valid Bitrix24 tokens stored server-side.
3. The `leadAuth` middleware verifies, via the Bitrix24 API, that the agent has permission to access the specified lead before allowing comment operations.

### Comment Validation
1. Comment body must be a non-empty string, trimmed, maximum 5000 characters.
2. Duplicate detection: the SHA-256 hash of the comment body is compared against recent entries in the audit log. Identical comments within the `DUPLICATE_WINDOW_SECONDS` (default 5 minutes) are rejected.
3. The raw comment body is never stored in the audit log. Only the hash is persisted.

### Rate Limiting
1. Authenticated endpoints: per-agent sliding window, default 10 requests per 60 seconds.
2. Auth endpoints: per-IP sliding window, default 5 requests per 60 seconds.
3. When the limit is exceeded, the API returns HTTP 429 with `retry_after_seconds` in the response body.

### Lead Detection
1. The content script monitors browser navigation on `*.bitrix24.com`.
2. Lead pages are identified by URL pattern matching (regex in `CONFIG.LEAD_URL_PATTERN`).
3. When a lead page is detected, the content script sends `LEAD_DETECTED { leadId }` to the service worker.
4. When the user navigates away from a lead page, `LEAD_NOT_DETECTED` is sent.
5. Navigation events are throttled to `NAVIGATION_THROTTLE_MS` (default 500ms) to avoid flooding during SPA transitions.

## Bitrix24 REST API Methods Used

| Method | Bitrix24 Endpoint | Our Route |
|---|---|---|
| Get lead info | `crm.lead.get` | `GET /api/leads/:leadId` |
| Add timeline comment | `crm.timeline.comment.add` | `POST /api/comments` |
| Update timeline comment | `crm.timeline.comment.update` | `PUT /api/comments/:commentId` |
| Delete timeline comment | `crm.timeline.comment.delete` | `DELETE /api/comments/:commentId` |
| Verify lead access | `crm.lead.get` (permission check) | `leadAuth` middleware |

All Bitrix24 API calls use the stored Bitrix24 access token, appended as `?auth=<token>` to the request URL. When the Bitrix24 API returns a rate limit (HTTP 429), the `bitrix24Client` queues the request and retries with exponential backoff.

## Terminology Glossary

| Term | Definition |
|---|---|
| Portal | A Bitrix24 instance identified by domain (e.g. `company.bitrix24.com`) |
| Member ID | Unique identifier for a user within a Bitrix24 portal |
| Client Endpoint | The REST API base URL for a specific Bitrix24 portal |
| Timeline | The activity feed on a CRM lead record |
| JTI | JWT Token Identifier; a unique ID for each issued JWT, used for blacklisting |
| OAuth State | A CSRF protection token generated during the login flow |
| Governed Workflow | Comment operations that are validated, rate-limited, and audit-logged |
