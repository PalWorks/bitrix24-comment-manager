# Secrets Management

## Overview

All sensitive configuration values are stored in Google Cloud Secret Manager and injected into Cloud Run as environment variables at container startup. No secrets are committed to source control.

## Required Secrets

| Secret Name | Description | How to Generate |
|-------------|-------------|-----------------|
| `jwt-secret` | JWT signing key | `openssl rand -base64 64` |
| `b24-client-id` | Bitrix24 OAuth2 application client ID | From Bitrix24 admin portal |
| `b24-client-secret` | Bitrix24 OAuth2 application client secret | From Bitrix24 admin portal |
| `database-url` | PostgreSQL connection string | From Cloud SQL instance |
| `b24-portal-domain` | Bitrix24 portal domain | From Bitrix24 admin portal |

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

echo -n "postgresql://user:pass@host/db" | \
  gcloud secrets create database-url --data-file=-

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
