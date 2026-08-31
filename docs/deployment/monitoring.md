# Monitoring and Alerting

## Overview

Production monitoring uses Google Cloud Monitoring (formerly Stackdriver) for metrics, dashboards, and alerting. Structured JSON logs are shipped to Cloud Logging for search and analysis.

## Dashboards

### 1. Backend Health

Metrics:
- **Request rate**: requests per second by endpoint
- **Error rate**: 4xx and 5xx responses per second
- **Latency**: P50, P95, P99 response times

Source: Cloud Run built-in metrics (`run.googleapis.com/request_count`, `run.googleapis.com/request_latencies`)

### 2. Authentication

Metrics:
- **Login success rate**: successful `/auth/callback` responses vs total attempts
- **Token refresh rate**: `/auth/callback` calls with refresh token
- **Auth failures**: 401 and 403 response count

Source: Custom Cloud Logging metric filters on structured log fields `{route="/auth/*", statusCode}`.

### 3. Comments

Metrics:
- **CRUD operation counts**: POST, PUT, DELETE on `/api/comments`
- **Validation failure breakdown**: by error code (BAD_REQUEST, DUPLICATE, RATE_LIMITED)

Source: Custom Cloud Logging metric filters on structured log fields `{route="/api/comments", method, statusCode}`.

### 4. Database

Metrics:
- **Connection pool utilization**: active vs idle connections
- **Query latency**: average and P95 query execution time
- **Disk usage**: total and audit log table size

Source: Cloud SQL built-in metrics (`cloudsql.googleapis.com/database/postgresql/*`)

## Alert Policies

| Alert | Condition | Window | Notification Channel |
|-------|-----------|--------|---------------------|
| High error rate | > 5% 5xx responses | 5 minutes | Slack + Email |
| High latency | P95 > 3 seconds | 5 minutes | Slack |
| Auth failures spike | > 20 auth failures | 5 minutes | Email |
| Database connections | > 80% pool utilization | 5 minutes | Slack |
| Disk usage | > 80% audit log partition | 15 minutes | Email |

### Creating Alerts (gcloud CLI)

```bash
# Example: High error rate alert
gcloud alpha monitoring policies create \
  --display-name="High Error Rate" \
  --condition-display-name="5xx Error Rate > 5%" \
  --condition-filter='resource.type="cloud_run_revision" AND metric.type="run.googleapis.com/request_count" AND metric.label.response_code_class="5xx"' \
  --condition-threshold-value=0.05 \
  --condition-threshold-duration=300s \
  --notification-channels=CHANNEL_ID
```

## Structured Logging

The backend uses the `logger` utility (`backend/src/utils/logger.ts`) which outputs structured JSON logs. These are automatically ingested by Cloud Logging when running on Cloud Run.

### Log Fields

Every log entry includes:
- `timestamp`: ISO 8601
- `severity`: INFO, WARN, ERROR
- `message`: human readable description
- `context`: structured metadata (route, method, agentId, statusCode)

### Useful Log Queries

```
# Find all failed comment operations
resource.type="cloud_run_revision"
jsonPayload.context.route="/api/comments"
jsonPayload.context.statusCode>=400

# Find authentication failures
resource.type="cloud_run_revision"
jsonPayload.context.route=~"/auth/"
jsonPayload.context.statusCode=401

# Find rate-limited requests
resource.type="cloud_run_revision"
jsonPayload.context.code="RATE_LIMITED"
```

## Uptime Checks

Configure a Cloud Monitoring uptime check for the `/health` endpoint:

```bash
gcloud monitoring uptime create \
  --display-name="Backend Health Check" \
  --resource-type=cloud-run-revision \
  --monitored-resource="//run.googleapis.com/projects/PROJECT/locations/REGION/services/b24-comment-api" \
  --check-request-path="/health" \
  --period=60s
```
