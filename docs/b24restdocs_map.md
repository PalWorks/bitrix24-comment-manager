# Bitrix24 REST API Docs: Reference Map

Quick reference to the Bitrix24 REST API documentation, with the facts this
project depends on collected in one place.

Upstream source: https://apidocs.bitrix24.com and its documentation repository at
https://github.com/bitrix-tools/b24-rest-docs. Paths below are relative to that
repository.

## Authentication & Authorization

| Topic | Path | Key Facts |
|-------|------|-----------|
| Full OAuth2 Protocol | `settings/oauth/index.md` | Authorize at `{portal}/oauth/authorize/?client_id=...&state=...`. Exchange code at `oauth.bitrix.info/oauth/token/` with `grant_type=authorization_code`. Code lifetime: **30 seconds**. |
| Token Auto-Renewal | `settings/oauth/auto-renewal.md` | `grant_type=refresh_token` at `oauth.bitrix.info/oauth/token/`. `access_token` lifetime: **1 hour**. `refresh_token` lifetime: **180 days**. Store refresh_token, only renew when access_token fails. |
| Simplified OAuth | `settings/oauth/simple-way.md` | For apps running inside Bitrix24 UI. Auth data (`AUTH_ID`, `REFRESH_ID`) provided via POST on app open. |
| Authorization in REST | `settings/how-to-call-rest-api/authorization.md` | Two methods: webhook (permanent URL key) or OAuth token (pass as `auth` param in body or query). |
| REST Call General | `settings/how-to-call-rest-api/general-principles.md` | Methods callable via GET or POST. JSON or `x-www-form-urlencoded` supported. |
| Batch Requests | `settings/how-to-call-rest-api/batch.md` | Execute 50 REST calls in one batch. Counter increments by 1. |

## Rate Limits (`limits.md`)

| Tier | Burst Limit (X) | Drain Rate (Y/sec) |
|------|-----------------|---------------------|
| Enterprise | 250 | 5 |
| Others | 50 | 2 |

Error on limit: HTTP 503, code `QUERY_LIMIT_EXCEEDED`. Resource consumption: 480 seconds total operating time per method in 10-minute window.

## API Scopes (`api-reference/scopes/permissions.md`)

Key scope for this project: **`crm`** (covers leads, deals, contacts, companies, timeline).

## CRM Module (`api-reference/crm/`, 773 items)

| Sub-module | Path | Key Methods |
|------------|------|-------------|
| Leads | `crm/leads/` | `crm.lead.add`, `crm.lead.get`, `crm.lead.list`, `crm.lead.update`, `crm.lead.delete`, `crm.lead.fields` |
| Timeline Comments | `crm/timeline/comments/` | `crm.timeline.comment.add`, `.update`, `.delete`, `.get`, `.list`, `.fields` |
| Timeline Activities | `crm/timeline/activities/` (66 items) | Activity management, configurable activities |
| Timeline Log Messages | `crm/timeline/logmessage/` | Log message management |
| Timeline Actions | `crm/timeline/actions/` | Custom timeline entry types |
| Deals | `crm/deals/` (59 items) | Full CRUD + product rows |
| Contacts | `crm/contacts/` (40 items) | Full CRUD + custom fields |
| Companies | `crm/companies/` (40 items) | Full CRUD + custom fields |
| Universal | `crm/universal/` (110 items) | `crm.item.add/get/list/update/delete` for any CRM entity type |
| Requisites | `crm/requisites/` (71 items) | Bank details, addresses, presets |

### Timeline Comment API Specifics

**`crm.timeline.comment.add`**: `{ fields: { ENTITY_ID: int, ENTITY_TYPE: "lead", COMMENT: string, FILES?: [[name, base64]] } }`. Returns `{ result: commentId }`. Note: `fields` key must be **lowercase** (since crm v23.100.0).

**Error codes**: `OWNER_NOT_FOUND`, `ACCESS_DENIED`, `NOT_FOUND`, `INVALID_ARG_VALUE`, `100` (missing required fields).

**`crm.timeline.comment.update`**: `{ id: commentId, fields: { COMMENT: string } }`
**`crm.timeline.comment.delete`**: `{ id: commentId }`

## Other API Modules (for later phases reference)

| Module | Path | Size | Relevance |
|--------|------|------|-----------|
| Events | `api-reference/events/` | 14 items | Webhooks, offline events |
| Users | `api-reference/user/` | 16 items | User info API |
| Widgets | `api-reference/widgets/` | 119 items | UI embedding in Bitrix24 |
| Telephony | `api-reference/telephony/` | 55 items | Not needed |
| Tasks | `api-reference/tasks/` | 134 items | Not needed |
| Chat/IM | `api-reference/chats/` | 114 items | Not needed |

## SDKs (`sdk/`)

| SDK | Path | Notes |
|-----|------|-------|
| BX24 JS SDK | `sdk/bx24-js-sdk/` (52 items) | For apps inside Bitrix24 UI. Not applicable for Chrome extension. |
| b24jssdk | `sdk/b24jssdk/` | Modern JS SDK |
| CRest PHP SDK | `sdk/crest-php-sdk/` | Server-side PHP. Not applicable. |
| MCP | `sdk/mcp.md` | Bitrix24 MCP integration |

## Local Integrations (`local-integrations/`)

Three types of local apps: Static (HTML/JS, no server), Server with UI (iframe in Bitrix24), Server without UI (background sync). Our Chrome extension acts as an external client, using the **full OAuth2 protocol**.

## Tutorials (`tutorials/`, CRM-heavy at 54 items)

CRM tutorials at `tutorials/crm/` cover practical examples for deals, leads, contacts, quotes, automation, document generation, and more.

## Key Design Implications for Our Project

1. **OAuth2 flow**: Use full protocol (not simplified) since our extension is external to Bitrix24 UI
2. **Token in REST calls**: Pass `access_token` as `auth` parameter in request body (not HTTP header)
3. **Rate limiting on backend**: Implement our own per-agent limiter; also handle Bitrix24's 503 `QUERY_LIMIT_EXCEEDED` with backoff
4. **Scope**: Request `crm` scope (covers leads + timeline comments)
5. **Comment API**: Use lowercase `fields` key; `ENTITY_TYPE` is `"lead"` for lead comments
