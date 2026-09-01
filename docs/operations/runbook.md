# Operations Runbook

> **What this is.** A worked example of running the backend on Google Cloud Run
> with Cloud SQL, kept because the incident response, migration and audit
> queries in it apply anywhere. The `gcloud` commands do not.
>
> **The supported default is Docker Compose**, which brings up the backend and
> its database together on any host:
> [docs/deployment/docker.md](../deployment/docker.md). If that is what you are
> running, read sections 4 to 7 here and ignore the deployment commands.

## 1. Architecture Overview

### Component Diagram

```
Agent Browser
  Chrome Extension (Manifest V3)
    Popup UI  |  Service Worker  |  Options Page
    Content Script (injected into Bitrix24 tabs)
        |
        | HTTPS (JWT in Authorization header)
        v
  Backend API Server (Cloud Run)
    /auth/*  /api/comments  /api/leads  /api/activity
    Auth Module | Validator Chain | Rate Limiter
    Audit Logger (append only)
        |
        | HTTPS (OAuth2 access token)
        v
  Bitrix24 REST API
    crm.timeline.comment.add / update / delete
```

### Dependencies

| Component | Dependency | Protocol |
|-----------|-----------|----------|
| Chrome Extension | Backend API | HTTPS with JWT |
| Backend API | MySQL 8 (Cloud SQL for MySQL) | TCP with SSL |
| Backend API | Bitrix24 REST API | HTTPS with OAuth2 |
| Backend API | Secret Manager | GCP IAM |

### Key Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Shallow liveness (returns 200 if process is running) |
| `GET /readiness` | Deep readiness: configuration plus a `SELECT 1` against the database. Reports `mode: support-only` and skips the database check on a support mailbox instance |
| `GET /auth/login` | Initiates OAuth2 flow |
| `GET /auth/callback` | Handles the OAuth2 redirect from Bitrix24, issues the JWT |
| `POST /api/comments` | Create comment (proxied to Bitrix24) |
| `GET /api/activity` | Fetch recent audit log entries |

## 2. Deployment Procedures

### Backend Update

1. Merge changes to `main` branch
2. CI/CD workflow (`.github/workflows/deploy.yml`) triggers automatically
3. Monitor the GitHub Actions run for build/deploy status
4. Verify `GET /health` returns 200 after deployment

Manual deploy (if CI/CD is unavailable):
```bash
cd backend
docker build -t gcr.io/PROJECT_ID/b24-comment-api:$(git rev-parse --short HEAD) .
docker push gcr.io/PROJECT_ID/b24-comment-api:$(git rev-parse --short HEAD)
gcloud run deploy b24-comment-api \
  --image gcr.io/PROJECT_ID/b24-comment-api:$(git rev-parse --short HEAD) \
  --region us-central1
```

### Extension Update

1. Update version in `extension/manifest.json`
2. Run `bash scripts/build-extension.sh`
3. Upload the new `.zip` to Chrome Web Store Developer Dashboard
4. Submit for review

## 3. Scaling

### Cloud Run Auto-Scaling

Current configuration:
- Min instances: 2 (always warm)
- Max instances: 10
- CPU: 1 vCPU per instance
- Memory: 512 Mi per instance
- Concurrency: default (80 requests per instance)

To adjust scaling:
```bash
gcloud run services update b24-comment-api \
  --region us-central1 \
  --min-instances 3 \
  --max-instances 20
```

### Database Scaling

- Monitor connection pool utilization (alert at > 80%)
- Cloud SQL max connections depends on tier
- Consider upgrading tier if P95 query latency exceeds 200ms
- Upgrade tier:
  ```bash
  gcloud sql instances patch b24-comments-db --tier=db-g1-small
  ```

## 4. Incident Response

### Common Error Scenarios

| Symptom | Likely Cause | Investigation Steps | Mitigation |
|---------|-------------|---------------------|------------|
| 5xx spike | Backend crash or unhandled error | Check Cloud Logging for error stack traces | Roll back to previous revision |
| 401 responses | JWT secret mismatch or expired tokens | Verify `jwt-secret` in Secret Manager matches deployed config | Redeploy with correct secret |
| 429 responses | Rate limit exceeded by agents | Check rate limiter logs for agent IDs exceeding limits | Temporarily increase limits in config |
| 502/503 | Cloud Run cold start or downstream timeout | Check instance count and startup latency | Increase min-instances |
| Database connection errors | Pool exhaustion or Cloud SQL downtime | Check Cloud SQL status page and connection metrics | Restart instances; increase pool size |

### Escalation Path

1. On-call engineer reviews alerts and Cloud Logging
2. If backend issue: attempt rollback
3. If database issue: check Cloud SQL console, open GCP support ticket
4. If Bitrix24 API issue: check Bitrix24 status page, enable request queue backoff

## 5. Bitrix24 API Issues

### Rate Limit Exceeded

The backend implements exponential backoff with request queuing (`bitrix24Client.ts`). If rate limits are consistently hit:

1. Check which agents are making the most requests (audit log)
2. Review per-agent rate limiter settings
3. Consider staggering agent access to distribute load

### Token Refresh Failures

1. Verify `BITRIX24_CLIENT_SECRET` in Secret Manager is current
2. Check if the Bitrix24 OAuth2 application is still active
3. Verify the redirect URI matches the backend `/auth/callback` URL
4. Re-authorize the application in Bitrix24 admin portal if needed

### API Downtime

If `crm.timeline.comment.*` methods return errors:
1. Check https://www.bitrix24.com/status/ for known outages
2. Backend returns 502 to the extension after retry failure
3. Agents see "Bitrix24 API is temporarily unavailable" in the popup
4. No action needed; requests will succeed once the API recovers

## 6. Database Operations

### Running Migrations

```bash
# Apply all pending migrations in order. They are MySQL, and are written to be
# safe to re-apply: 004 and 005 in particular must be re-run on any deployment
# that predates 2.0.0.
for f in backend/migrations/*.sql; do
  echo "Applying $f..."
  mysql --host="$DB_HOST" --user="$DB_USER" --password="$DB_PASSWORD" "$DB_NAME" < "$f"
done
```

Running under Docker Compose, the database is inside the compose network:

```bash
for f in backend/migrations/*.sql; do
  docker compose exec -T db mysql -u root -p"$MYSQL_ROOT_PASSWORD" b24_comments < "$f"
done
```

### Backup and Restore

Automated backups are configured on Cloud SQL (daily, 30-day retention).

Manual backup:
```bash
gcloud sql backups create --instance=b24-comments-db
```

Restore from backup:
```bash
gcloud sql backups list --instance=b24-comments-db
gcloud sql backups restore BACKUP_ID --restore-instance=b24-comments-db
```

### Audit Log Queries

```sql
-- Recent actions by a specific agent
SELECT * FROM comment_audit_log
WHERE agent_id = 'AGENT_ID'
ORDER BY timestamp DESC
LIMIT 50;

-- Failed operations in the last 24 hours
SELECT * FROM comment_audit_log
WHERE status = 'FAILED'
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;

-- Comment operations for a specific lead
SELECT * FROM comment_audit_log
WHERE lead_id = 'LEAD_ID'
ORDER BY timestamp DESC;
```

### Retention Policy

Audit logs are retained for a minimum of 60 days. The `purge_expired_audit_logs()` function (migration 005) runs daily at 03:00 UTC via `pg_cron` and removes entries older than the configured retention period.

To manually purge:
```sql
SELECT purge_expired_audit_logs(60);
```

## 7. Monitoring

### Dashboard Links

Configure these in Google Cloud Console under Monitoring > Dashboards:

1. **Backend Health**: Request rate, error rate, latency
2. **Authentication**: Login success rate, auth failures
3. **Comments**: CRUD counts, validation failures
4. **Database**: Connections, query latency, disk usage

See `docs/deployment/monitoring.md` for detailed dashboard and alert configuration.

### Useful Cloud Logging Queries

```
# All errors in the last hour
resource.type="cloud_run_revision"
severity>=ERROR
timestamp>="2026-01-01T00:00:00Z"

# Requests from a specific agent
resource.type="cloud_run_revision"
jsonPayload.context.agentId="AGENT_ID"
```

## 8. Agent Provisioning

### Adding a New Agent

1. Insert agent record into the `agents` table:
   ```sql
   INSERT INTO agents (id, name, email, active)
   VALUES ('agent-uuid', 'Agent Name', 'agent@company.com', true);
   ```

2. Create agent-to-Bitrix24 user mapping:
   ```sql
   INSERT INTO agent_mappings (agent_id, bitrix_user_id)
   VALUES ('agent-uuid', 'bitrix-user-id');
   ```

3. The agent can now log in via the Chrome extension

### Deactivating an Agent

```sql
UPDATE agents SET active = false WHERE id = 'agent-uuid';
```

The agent's active sessions will fail at the next request (authorization chain step 3 checks `active = true`).

### Verifying Agent Configuration

```sql
SELECT a.id, a.name, a.active, m.bitrix_user_id
FROM agents a
JOIN agent_mappings m ON a.id = m.agent_id
WHERE a.id = 'agent-uuid';
```
