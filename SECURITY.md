# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub's private vulnerability reporting: go to the
**Security** tab of this repository and choose **Report a vulnerability**. That
opens a private channel with the maintainers.

Please include what the issue is, how to reproduce it, and what an attacker could
achieve. A proof of concept helps but is not required.

You can expect an acknowledgement within a week and an assessment within two.
There is no bounty programme.

## Supported versions

The `main` branch is the supported version. Fixes land there.

## Deploying this safely

This project handles CRM data and OAuth credentials. Some of its security
properties depend on how you deploy it:

| Your responsibility | Why |
|---|---|
| Set `TOKEN_ENCRYPTION_KEY` in production | Without it the backend refuses to start, which is deliberate: it is what keeps Bitrix24 refresh tokens encrypted at rest |
| Set `CORS_ORIGINS` to your extension ID | The default `*` lets any origin call your backend |
| Terminate TLS | The backend redirects to HTTPS and sets HSTS, but it does not terminate TLS itself |
| Keep `BITRIX24_ALLOWED_PORTALS` narrow | `*` lets the backend start an OAuth flow for any portal |
| Protect the database | The audit log is the record of who did what. Restrict access to it |
| Rotate `JWT_SECRET` if it leaks | Every issued JWT stays valid until expiry otherwise |

## What the project does on its own

- Bitrix24 OAuth credentials stay server side and never reach the browser.
- Access and refresh tokens are encrypted with AES-256-GCM before storage.
- The JWT lives in `chrome.storage.session`: memory backed, cleared when the
  browser closes, and unreachable from content scripts or web pages.
- JWTs are short lived and their identifiers are blacklisted on refresh and
  logout.
- Comment bodies are never persisted, only a SHA-256 hash.
- Audit rows cannot be updated or deleted, enforced by a database trigger.
- Failed authorization attempts are audited, not only successful operations.

## Known limitations

Stated plainly so you can judge the risk yourself:

- The JWT blacklist, OAuth state store, and rate limiter windows are per process.
  Behind a load balancer, a logged out token stays usable on other instances
  until it expires, and rate limits apply per instance.
- The retention purge deliberately bypasses the audit immutability trigger via a
  session variable. Anyone with SQL access could do the same, though anyone with
  SQL access could also drop the trigger. The trigger defends against application
  bugs, not against a database administrator.
