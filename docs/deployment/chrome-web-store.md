# Chrome Web Store Submission Guide

## Prerequisites

1. A Google account enrolled in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. One-time $5 registration fee (if not already paid)
3. The production extension `.zip` bundle (built via `scripts/build-extension.sh`)

## Step 1: Build the Production Bundle

```bash
export VITE_BACKEND_URL=https://b24-comment-api-HASH.run.app
bash scripts/build-extension.sh
```

The output `.zip` file will be in the `build/` directory.

## Step 2: Upload to Chrome Web Store

1. Navigate to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. Click **New Item**
3. Upload the `.zip` file from `build/`
4. Wait for the upload to process

## Step 3: Complete Store Listing

| Field | Value |
|-------|-------|
| Name | Bitrix24 Comment Manager |
| Summary | Governed comment workflow for Bitrix24 CRM leads |
| Category | Productivity |
| Language | English |

### Description

```
Bitrix24 Comment Manager provides a governed, auditable workflow for managing
comments on Bitrix24 CRM leads. All comment operations flow through a secured
backend API that enforces authentication, authorization, rate limiting, duplicate
detection, and immutable audit logging.

Features:
  Lead detection from active Bitrix24 tabs
  Comment creation, editing, and deletion via governed workflow
  Voice to text input for comment drafting
  Real-time session and activity monitoring
  Complete audit trail for all comment operations
```

### Screenshots

Capture and upload screenshots of:
1. Popup in logged-out state (showing login button)
2. Popup with active lead and comment form
3. Options page showing activity table

### Privacy Policy

Host a privacy policy at a public URL and enter it in the listing. The policy must cover:
- Data collected (agent identity, comment content hashed, lead IDs)
- Data storage (backend database, audit logs retained 60+ days)
- Data sharing (proxied to Bitrix24 API only)
- No analytics or third-party tracking

## Step 4: Permissions Justification

| Permission | Justification |
|------------|---------------|
| `identity` | Required for OAuth2 authentication flow with Bitrix24 |
| `activeTab` | Required to detect the current Bitrix24 tab URL for lead identification |
| `tabs` | Required to track lead state across multiple open Bitrix24 tabs |
| Host permission `*.bitrix24.com` | Required for content script injection to parse lead URLs on Bitrix24 pages |

## Step 5: Submit for Review

1. Click **Submit for Review**
2. Monitor the review status in the dashboard (typically 1 to 3 business days)
3. Respond promptly to any policy questions from the review team

## Step 6: Post-Submission

After approval:
1. Verify the extension installs correctly from the Chrome Web Store
2. Test the full login and comment workflow with the production backend
3. Confirm the extension ID matches what is configured in `CORS_ORIGINS`


## Upgrading an existing listing

### v2.0.2

Removes the unused `activeTab` permission. Removing a permission does not
trigger a review; it shortens the install prompt and removes the risk of a
rejection for asking for something the extension does not use.

### v2.0.1

No manifest change, so no permission review. It is a resilience pass over the
same feature set, and it uploads like any ordinary update. See the changelog for
what it fixes.

One thing to check before building: `VITE_SUPPORT_URL` now lives in the
committed `.env.production` rather than being passed on the command line. Confirm
it survives into the artifact, which `scripts/build-extension.sh` reports.

## Filling in the Privacy tab

Every field below is required, and the dashboard will not let you submit until
each is filled. These are current as of 2.0.2; **if you change the manifest,
change these in the same commit.**

| Field | Text |
|---|---|
| Single purpose | Lets authorised CRM agents add, edit and delete timeline comments on Bitrix24 lead pages from a popup, without leaving the lead. |
| `tabs` | Reads the URL of the active tab to work out which Bitrix24 lead is open, and opens the extension's own Help page in a new tab. No browsing history is read or stored. |
| `storage` | `chrome.storage.local` holds the backend URL the user enters and the list of portals they have added. `chrome.storage.session` holds the session token and the comments submitted in the current session, so the popup keeps its state when it is closed and reopened. Neither is transmitted anywhere. |
| `scripting` | Registers a content script at runtime for a Bitrix24 portal the user has added themselves, on a domain the static `*.bitrix24.com` match cannot cover. Used only through `chrome.scripting.registerContentScripts`, and unregistered when the user removes the portal. No code is injected into arbitrary pages. |

Host permission justification:

> Static grant: `https://*.bitrix24.com/*` runs a content script that reads only
> the page URL, to detect the CRM lead ID, and sends that ID to the service
> worker. It does not read or modify page content.
>
> Optional grant: `https://*/*` is never requested at install time. Bitrix24
> also serves portals on regional top level domains, on customer owned domains,
> and on self hosted installations, and publishes no list of them; match
> patterns cannot wildcard a top level domain, so the set cannot be enumerated
> in the manifest. It is requested one origin at a time through
> `chrome.permissions.request`, only when a user adds their own portal on the
> options page, and it is revoked when they remove it.
>
> Navigation between leads without a page reload is detected with a throttled
> MutationObserver plus the popstate and hashchange events.

**Remote code: No.** The CSP is `script-src 'self'`, everything is bundled, and
nothing is fetched and evaluated at runtime.

### Data usage

Check both of these, and nothing else:

| Category | Why |
|---|---|
| **Personally identifiable information** | The Get help form collects a name, an email address and optionally a phone number, and sends them to the publisher's support service |
| **Authentication information** | The session token, and the Bitrix24 OAuth tokens the backend holds |

Comment text is not one of the nine categories. It is a CRM record written by
the user and sent only to the backend that user configured; it is neither
website content read from a page nor a personal communication.

### Privacy policy URL

`https://palworks.github.io/bitrix24-comment-manager/privacy/`

### v2.0.0

v2.0.0 adds two things that trigger a **permission review**, which is slower than
a normal update. Expect several days rather than one.

| New in the manifest | Why it is there |
|---|---|
| `"scripting"` permission | Registers a content script for a portal the user adds, on a domain the static match cannot cover |
| `optional_host_permissions: ["https://*/*"]` | Bitrix24 portals live on regional domains, customer owned domains, and self hosted installs. There is no published list to enumerate, and match patterns cannot wildcard a top level domain |

### Justification text for the review form

Reviewers ask why a broad host permission is needed. This is accurate and has
the shape they look for:

> The extension operates on Bitrix24 CRM portals. Bitrix24 serves portals on
> several regional top level domains, on customer owned domains, and on self
> hosted installations, and publishes no list of them. Chrome match patterns
> cannot wildcard a top level domain, so the set cannot be enumerated in the
> manifest.
>
> The permission is **optional**, never requested at install time. It is
> requested one origin at a time, through `chrome.permissions.request`, only
> when a user explicitly adds their own portal on the options page, and it is
> revoked when they remove it. The default installed grant is limited to
> `https://*.bitrix24.com/*`.
>
> The content script reads only the page URL, to detect the CRM lead ID, and
> sends that ID to the extension's service worker. It does not read page
> content, does not modify the page, and does not transmit anything to a third
> party.

### Before you submit

- The build carries **no backend URL**. Users configure one on first run. If you
  want a pre-configured build for your own users, set `VITE_BACKEND_URL` before
  building and say so in the listing description.
- The build **does** carry a support URL, from `.env.production`. That is
  deliberate: the Get help form has to reach the publisher, so it is not a user
  setting. A fork should change it or empty it, which hides the form and offers
  the issue tracker instead.
- `CORS_ORIGINS` on the backend must contain the published extension ID. That ID
  does not change when you update an existing listing.
- Privacy tab: the extension stores a session token and the user's chosen
  backend URL locally. It transmits comment text only to the backend the user
  configured. Declare accordingly, and update this if you later enable
  telemetry.
