# Data Model

This document describes all data schemas, entity relationships, and the migration strategy for the Bitrix24 Comment Manager system.

## MySQL Schema

### Table: `comment_audit_log`

This is the only persisted table in the system. It records every comment operation and authentication failure.

```sql
CREATE TABLE comment_audit_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    agent_id        VARCHAR(255) NOT NULL,
    bitrix_user_id  VARCHAR(255),
    lead_id         VARCHAR(255) NOT NULL,
    comment_id      VARCHAR(255),
    action_type     VARCHAR(50) NOT NULL,
    comment_hash    VARCHAR(64) NOT NULL,
    timestamp       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip_address      VARCHAR(45),
    status          VARCHAR(20) NOT NULL,
    failure_reason  TEXT
);

CREATE INDEX idx_audit_agent_id ON comment_audit_log (agent_id);
CREATE INDEX idx_audit_timestamp ON comment_audit_log (timestamp DESC);
CREATE INDEX idx_audit_lead_id ON comment_audit_log (lead_id);
CREATE INDEX idx_audit_dedup ON comment_audit_log (agent_id, lead_id, comment_hash, timestamp);
```

**Column details:**

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INT AUTO_INCREMENT` | Primary key | Auto-incrementing row ID |
| `agent_id` | `VARCHAR(255)` | NOT NULL | JWT `memberId` claim (Bitrix24 member ID) |
| `portal_domain` | VARCHAR(255) | Portal the action targeted. Empty for rows written before multi-portal support |
| `bitrix_user_id` | `VARCHAR(255)` | Nullable | The Bitrix24 user ID from stored tokens |
| `lead_id` | `VARCHAR(255)` | NOT NULL | The CRM lead ID being acted upon |
| `comment_id` | `VARCHAR(255)` | Nullable | Bitrix24 comment ID (null for failed creates) |
| `action_type` | `VARCHAR(50)` | NOT NULL | One of: `CREATE`, `EDIT`, `DELETE`, `AUTH_FAILURE` |
| `comment_hash` | `VARCHAR(64)` | NOT NULL | SHA-256 hex digest of the comment body |
| `timestamp` | `DATETIME` | NOT NULL, default CURRENT_TIMESTAMP | ISO 8601 timestamp of the action |
| `ip_address` | `VARCHAR(45)` | Nullable | Client IP from `req.ip` (supports IPv6) |
| `status` | `VARCHAR(20)` | NOT NULL | `SUCCESS` or `FAILED` |
| `failure_reason` | `TEXT` | Nullable | Error message when `status = FAILED` |

**Indexes:**

| Index | Columns | Purpose |
|---|---|---|
| `idx_audit_agent_id` | `agent_id` | Fast activity log queries per agent |
| `idx_audit_timestamp` | `timestamp DESC` | Time-ordered queries, retention cleanup |
| `idx_audit_lead_id` | `lead_id` | Per-lead audit trail |
| `idx_audit_dedup` | `agent_id, lead_id, comment_hash, timestamp` | Duplicate comment detection |

## In-Memory Data Stores (Backend)

These are Maps in the Node.js process. They are not persisted across restarts and
are not shared between instances.

### Token Service (`services/tokenService.ts`)

```typescript
// Blacklisted JWT IDs, keyed by JTI, value is expiry timestamp
const jtiBlacklist = new Map<string, number>();

// OAuth CSRF state tokens, keyed by nonce, value has createdAt
const oauthStateStore = new Map<string, OAuthState>();
```

Bitrix24 tokens are no longer among these. They live in `bitrix_tokens`
(see below), because holding them only in memory de-authenticated every agent on
each restart.

**Cleanup:** Expired entries are pruned every 60 seconds by `pruneExpiredBlacklistEntries()` and `pruneExpiredOAuthStates()`. Timers use `.unref()` and are stopped on shutdown via `stopCleanupTimers()`.

### Rate Limiter (`middleware/rateLimiter.ts`)

```typescript
// Per-agent request counts, keyed by memberId
const agentWindows = new Map<string, WindowEntry>();

// Per-IP request counts, keyed by IP address
const ipWindows = new Map<string, WindowEntry>();

interface WindowEntry {
    count: number;       // Requests in current window
    windowStart: number; // Window start timestamp (ms)
    windowMs: number;    // Window duration (ms)
}
```

**Cleanup:** Expired entries are pruned every 60 seconds by `pruneExpiredEntries()`. Timer uses `.unref()` and is stopped on shutdown via `stopPruneTimer()`.

## In-Memory Data Stores (Extension)

### Token Manager (`background/tokenManager.ts`)

The JWT is held in `chrome.storage.session` under the key `auth`, with an
in-process cache in front of it:

```typescript
interface StoredToken {
    jwt: string;
    expiresAt: number;   // Unix seconds
}

let cached: StoredToken | null = null;      // read-through cache
let refreshTimerId: ReturnType<typeof setTimeout> | null = null;
let refreshInProgress: Promise<void> | null = null; // concurrent refresh guard
```

Manifest V3 terminates an idle service worker, so a module variable alone would
log the agent out mid-session. `chrome.storage.session` is memory backed, cleared
when the browser closes, and unreachable from content scripts.
`resumeSession()` reinstates the refresh timer on each worker startup.

### Settings (`shared/settings.ts`)

Persisted in `chrome.storage.local` under the key `settings`:

```typescript
interface Settings {
    backendUrl: string;   // origin of the backend, no trailing slash
    portals: string[];    // portals added beyond *.bitrix24.com
}
```

This is deliberately `local` rather than `session`: configuration must survive a
browser restart, and none of it is a credential.

### Lead State (`background/leadState.ts`)

```typescript
// Per-tab lead ID tracking, keyed by Chrome tab ID
const leadState = new Map<number, string | null>();
```

## JWT Token Structure

Issued by `tokenService.signJwt()`. Verified by `jwtAuth` middleware.

```json
{
    "memberId": "abc123",
    "domain": "company.bitrix24.com",
    "clientEndpoint": "https://company.bitrix24.com/rest",
    "jti": "550e8400-e29b-41d4-a716-446655440000",
    "iat": 1709568000,
    "exp": 1709571600
}
```

| Claim | Type | Description |
|---|---|---|
| `memberId` | String | Bitrix24 member ID (unique per portal user) |
| `domain` | String | Portal domain |
| `clientEndpoint` | String | REST API base URL for the portal |
| `jti` | String (UUID) | Unique token identifier for blacklisting |
| `iat` | Number (Unix seconds) | Issued at timestamp |
| `exp` | Number (Unix seconds) | Expiry timestamp (default: iat + 3600) |

## Bitrix24 Token Storage

### Table: `bitrix_tokens`

Written after a successful OAuth callback and after every token refresh. Keyed by
`member_id`.

| Column | Type | Notes |
|---|---|---|
| `member_id` | VARCHAR(255) PK | Bitrix24 member ID |
| `portal_domain` | VARCHAR(255) | Portal this member belongs to |
| `client_endpoint` | VARCHAR(512) | REST API base URL |
| `access_token` | TEXT | Encrypted, AES-256-GCM |
| `refresh_token` | TEXT | Encrypted, AES-256-GCM |
| `expires_at` | BIGINT | Access token expiry, Unix seconds |
| `created_at` / `updated_at` | DATETIME(6) | Maintained by the database |

`services/tokenStore.ts` keeps a process cache in front of this table, so the
request path usually resolves tokens without a query. The in-memory shape is:

```typescript
interface BitrixTokens {
    accessToken: string;     // Bitrix24 API access token
    refreshToken: string;    // Bitrix24 API refresh token
    clientEndpoint: string;  // REST API base URL
    domain: string;          // Portal domain
    expiresAt: number;       // Access token expiry (Unix seconds)
}
```

### Encryption at rest

Both tokens are encrypted by `utils/crypto.ts` before they reach the database,
under `TOKEN_ENCRYPTION_KEY` (64 hex characters). The stored format is
`v1.<iv>.<authTag>.<ciphertext>`, each part base64. A random 96 bit IV per record
means identical credentials never produce identical rows. Losing or changing the
key invalidates every stored token, so every agent has to log in again.

Without `DATABASE_URL`, which is the documented development setup, the cache is
the only store and tokens are lost on restart.

## Entity Relationships

```
Agent (memberId)
  ├── 1:1 BitrixTokens (in-memory, keyed by memberId)
  ├── 1:1 JWT (in-flight, contains memberId + domain + clientEndpoint)
  ├── 1:N AuditLogEntries (in MySQL, agent_id = memberId)
  └── N:M Leads (accessed via Bitrix24 API, authorized by leadAuth)

Lead (lead_id)
  ├── 1:N TimelineComments (in Bitrix24, managed via REST API)
  └── 1:N AuditLogEntries (in MySQL, lead_id = lead_id)

TimelineComment (comment_id)
  ├── belongs to Lead
  └── 1:1 AuditLogEntry per operation
```

## Migration Strategy

Database migrations are stored as numbered SQL files. The naming convention is:

```
migrations/
  001_create_audit_log.sql
  002_add_indexes.sql
  003_add_columns.sql
```

Migrations are applied manually using the `mysql` CLI or a migration tool before deploying a new version that requires schema changes. There is no automated migration runner in the application because the schema changes infrequently and manual application provides an additional safety check.

**To apply a migration:**

```bash
mysql -h 127.0.0.1 -u <user> -p <dbname> < migrations/003_add_columns.sql
```

**Rule:** Migrations must be backward-compatible. Add columns as nullable or with defaults. Never drop columns in the same release that stops writing to them.
