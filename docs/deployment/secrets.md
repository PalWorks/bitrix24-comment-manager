# Secrets Management

> **What this is.** The list of secrets applies to every deployment. The
> `gcloud` commands are one worked example, for Google Cloud Secret Manager and
> Cloud Run. Running under Docker Compose, the same values go in a `.env` file
> with mode `600` beside the compose file; see
> [docker.md](docker.md).

## Overview

Nothing sensitive is committed to source control. Whatever store you use, these
are the values it has to hold.

## Required Secrets

| Value | Description | How to Generate |
|---|---|---|
| `JWT_SECRET` | Signs the session tokens the extension holds | `openssl rand -hex 32` |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Bitrix24 refresh tokens at rest. Exactly 64 hex characters, and the backend refuses to start in production without it | `openssl rand -hex 32` |
| `BITRIX24_CLIENT_ID` | Bitrix24 OAuth2 application client ID | From the Bitrix24 admin portal |
| `BITRIX24_CLIENT_SECRET` | Bitrix24 OAuth2 application client secret | From the Bitrix24 admin portal |
| `DATABASE_URL` | MySQL connection string, `mysql://user:pass@host:3306/db` | From your database |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | Only when the database runs in the same compose project | Any strong values |
| `RESEND_API_KEY` | Optional. Only on an instance that receives support mail | From resend.com |

**`TOKEN_ENCRYPTION_KEY` is the one that cannot be regenerated.** Lose it and
every stored Bitrix24 token becomes undecryptable, and every agent has to
reconnect. Keep a copy somewhere other than the server.

`BITRIX24_PORTAL_DOMAIN` and `BITRIX24_ALLOWED_PORTALS` are configuration rather
than secrets; they name portals, and knowing a portal hostname grants nothing.

## Creating Secrets in Google Cloud

```bash
# Enable the Secret Manager API
gcloud services enable secretmanager.googleapis.com

# Create each secret
echo -n "$(openssl rand -base64 64)" | \
  gcloud secrets create jwt-secret --data-file=-

echo -n "your-client-id" | \
  gcloud secrets create b24-client-id --data-file=-

echo -n "your-client-secret" | \
  gcloud secrets create b24-client-secret --data-file=-

echo -n "mysql://user:pass@host:3306/b24_comments" | \
  gcloud secrets create database-url --data-file=-

echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets create token-encryption-key --data-file=-

echo -n "your-org.bitrix24.com" | \
  gcloud secrets create b24-portal-domain --data-file=-
```

## Granting Cloud Run Access

The Cloud Run service account needs the `secretmanager.secretAccessor` role:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Mapping Secrets to Environment Variables

The `deploy.yml` workflow maps secrets to environment variables via the `--set-secrets` flag:

```
JWT_SECRET=jwt-secret:latest
BITRIX24_CLIENT_ID=b24-client-id:latest
BITRIX24_CLIENT_SECRET=b24-client-secret:latest
DATABASE_URL=database-url:latest
BITRIX24_PORTAL_DOMAIN=b24-portal-domain:latest
```

## Rotating Secrets

1. Create a new version of the secret:
   ```bash
   echo -n "new-value" | \
     gcloud secrets versions add jwt-secret --data-file=-
   ```
2. Redeploy the Cloud Run service to pick up the new version (`:latest` always resolves to the newest active version).
3. Disable the old version:
   ```bash
   gcloud secrets versions disable OLD_VERSION_ID --secret=jwt-secret
   ```

## Local Development

For local development, copy `backend/.env.example` and fill in values. The `dotenv` package loads these automatically. Never use production secrets locally.
