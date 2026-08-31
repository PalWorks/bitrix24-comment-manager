# Setup

End to end setup, from a fresh clone to commenting on a lead. Budget about
twenty minutes, most of it waiting on Bitrix24.

Placeholders: replace `api.example.com` with your backend hostname and
`your-portal.bitrix24.com` with your portal.

## 1. Register a Bitrix24 application

This is the step people get stuck on, so it is first and in full.

1. Sign in to your Bitrix24 portal as an administrator.
2. Go to **Developer resources**. Depending on your version this sits under
   **Applications**, **Market**, or directly at
   `https://your-portal.bitrix24.com/devops/`.
3. Choose **Other** then **Local application** (sometimes labelled
   "Local application" or "Add local application" directly).
4. Fill it in:

   | Field | Value |
   |---|---|
   | Name | Anything, for example `Comment Manager` |
   | Type | **Server application (used with OAuth 2.0 protocol)** |
   | Handler path (redirect URI) | `https://api.example.com/auth/callback` |
   | Initial installation path | Leave empty |
   | Assign permissions (scope) | **CRM (crm)** |
   | Uses only API | Yes, if offered |

   The handler path must match your backend's `BACKEND_URL` exactly, scheme,
   host, and port included. A mismatch is the single most common cause of a
   failed login.

5. Save. Bitrix24 shows an **Application ID (client_id)** and an
   **Application key (client_secret)**. Copy both now; the secret is not always
   shown again.

For local development, register a second application with the handler path
`http://localhost:3000/auth/callback`. Bitrix24 accepts a localhost handler.

## 2. Prepare the database

Production requires MySQL 8 or newer. Local development does not, though without
it audit entries are dropped and tokens do not survive a restart.

```sql
CREATE DATABASE b24_comments CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'b24'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON b24_comments.* TO 'b24'@'localhost';
FLUSH PRIVILEGES;
```

Apply the migrations in numeric order:

```bash
for f in backend/migrations/*.sql; do
    echo "applying $f"
    mysql -u b24 -p b24_comments < "$f"
done
```

Migration 005 installs a scheduled retention purge. If your host does not allow
the MySQL event scheduler, drop the event and call the procedure from cron
instead:

```sql
DROP EVENT IF EXISTS evt_purge_audit_logs;
```

```bash
0 3 * * * mysql -u b24 -p'...' b24_comments -e "CALL purge_expired_audit_logs(60)"
```

## 3. Configure and run the backend

```bash
npm install
cp backend/.env.example backend/.env
```

Generate the two secrets:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # TOKEN_ENCRYPTION_KEY
```

Fill in `backend/.env`:

```
BACKEND_URL=http://localhost:3000
JWT_SECRET=<first generated value>
TOKEN_ENCRYPTION_KEY=<second generated value>
BITRIX24_CLIENT_ID=<application id>
BITRIX24_CLIENT_SECRET=<application key>
BITRIX24_ALLOWED_PORTALS=your-portal.bitrix24.com
DATABASE_URL=mysql://b24:a-strong-password@localhost:3306/b24_comments
```

`TOKEN_ENCRYPTION_KEY` encrypts stored Bitrix24 refresh tokens. Losing it means
every agent has to log in again; changing it has the same effect. Back it up
alongside your other secrets.

Start it:

```bash
cd backend && npm run dev
curl http://localhost:3000/health      # {"status":"ok"}
curl http://localhost:3000/readiness   # config and database checks
```

If `/readiness` reports `database: false`, `DATABASE_URL` is wrong or MySQL is
unreachable. The error detail is in the backend log.

### Serving several portals from one backend

`BITRIX24_ALLOWED_PORTALS` accepts a comma separated list, with `*.suffix`
wildcards:

```
BITRIX24_ALLOWED_PORTALS=acme.bitrix24.com,*.bitrix24.de
```

The application must be installed on each portal you intend to serve. Setting the
value to `*` makes the backend start an OAuth flow for any portal that asks;
only do that deliberately, and expect a warning in the log.

## 4. Build and load the extension

```bash
cd extension && npm run build
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked**, and select `extension/dist/`.
4. Note the extension ID Chrome assigns.

Add that ID to the backend allowlist and restart it:

```
CORS_ORIGINS=chrome-extension://<the id you noted>
```

During local development you can leave `CORS_ORIGINS` unset. It defaults to `*`,
which is fine on localhost and warns in production.

## 5. Connect

1. Click the extension icon. It asks for your backend URL on first run. Enter
   `http://localhost:3000` (or your production URL) and save.
2. Click **Connect to Bitrix24**. A small window opens with the Bitrix24 consent
   screen.
3. Approve. The window closes and the popup shows your portal, member ID, and
   session expiry.

## 6. Use it

Open a lead, for example
`https://your-portal.bitrix24.com/crm/lead/details/1/`. The popup shows the lead
ID and name. Type a comment and submit. It appears on the Bitrix24 timeline and
in the audit log.

## Portals other than bitrix24.com

Portals on `bitrix24.com` work with no extra step. For a regional domain, your
own domain, or a self hosted install:

1. Open the extension options (right click the icon, then **Options**).
2. Under **Bitrix24 portals**, enter the hostname, for example
   `acme.bitrix24.de`, and click **Add portal**.
3. Approve the Chrome permission prompt.

The extension registers a content script for that portal. Add the portal to
`BITRIX24_ALLOWED_PORTALS` on the backend as well.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login window shows a Bitrix24 error about the redirect URI | The handler path does not match `BACKEND_URL` exactly |
| Login window opens, nothing happens after approving | `BACKEND_URL` is not reachable from the browser, or the callback errored. Check the backend log |
| `403` with "not configured to serve the portal" | Portal missing from `BITRIX24_ALLOWED_PORTALS` |
| Popup says "Backend unreachable" | Backend down, or its origin is blocked by CORS. Check `CORS_ORIGINS` |
| Popup says "Not a lead page" on a lead | Portal is not `bitrix24.com` and has not been added on the options page |
| Comments succeed but the audit log is empty | `DATABASE_URL` unset or wrong. Check `/readiness` |
| `TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters` | Regenerate with `openssl rand -hex 32` |
