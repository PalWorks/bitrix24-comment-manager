# Playbook: Operational Procedures

Step-by-step procedures for common development and operations tasks. Agents should follow these exactly.

## Adding a New API Endpoint

1. **Define the route handler** in the appropriate file under `backend/src/routes/`. If the resource is new, create a new router file.

2. **Add middleware** to the route chain. For authenticated endpoints, the standard chain is:
   ```typescript
   router.post('/resource', jwtAuth, agentAuth, rateLimiter, (req, res, next) => { ... });
   ```
   If the endpoint modifies a specific lead, add `leadAuth` after `agentAuth`.

3. **Register the router** in `backend/src/server.ts`:
   ```typescript
   import { newRouter } from './routes/newResource.js';
   app.use('/api/newResource', newRouter);
   ```

4. **Add audit logging** if the endpoint modifies data:
   ```typescript
   writeAuditLog({ ... }); // No await, fire and forget
   ```

5. **Write unit tests** in `tests/unit/backend/<routeName>.test.ts`.

6. **Update docs**: Add the endpoint to `README.md` API Reference and `CONTEXT_MAP.md`.

## Adding a New Message Type (Extension)

1. **Add the constant** to `extension/shared/constants.ts`:
   ```typescript
   export const MESSAGE_TYPES = {
       // ... existing types
       NEW_ACTION: 'NEW_ACTION',
   } as const;
   ```

2. **Add the type interface** (if needed) to `extension/shared/types.ts`.

3. **Add the handler** in `extension/background/messageRouter.ts`:
   ```typescript
   case MESSAGE_TYPES.NEW_ACTION: {
       const payload = message.payload as { ... } | undefined;
       // Validate payload
       apiRequest<ResponseType>('/api/endpoint', { method: 'POST', body: payload })
           .then((result) => sendResponse(result))
           .catch((error) => {
               const msg = error instanceof Error ? error.message : 'Action failed';
               sendResponse({ success: false, error: msg });
           });
       return true; // Async response
   }
   ```

4. **Call it from the UI** in `popup/popup.ts` or `options/options.ts`:
   ```typescript
   const result = await sendMessage(MESSAGE_TYPES.NEW_ACTION, { key: 'value' });
   ```

5. **Write tests** and update `CONTEXT_MAP.md`.

## Adding a New Environment Variable

1. **Add to `config.ts`** interface and `loadConfig()`:
   ```typescript
   // In AppConfig interface:
   newSetting: string;

   // In loadConfig():
   newSetting: optionalEnv('NEW_SETTING', 'default'),
   // OR for required:
   newSetting: requireEnv('NEW_SETTING'),
   ```

2. **Add validation** if the variable has production-only requirements:
   ```typescript
   if (config.nodeEnv === 'production' && !config.newSetting) {
       throw new Error('NEW_SETTING is required in production.');
   }
   ```

3. **Update deployment config**: Add to `deploy.yml` `--set-secrets` or `--set-env-vars` as appropriate.

4. **Update docs**: Add to the Configuration table in `README.md`.

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests (uses mock servers, no external deps)
npm run test:integration

# With coverage report
npm run test:coverage

# Single test file
npx vitest run tests/unit/backend/rateLimiter.test.ts

# Watch mode during development
npx vitest tests/unit/backend/rateLimiter.test.ts
```

## Building for Production

### Extension

```bash
./scripts/build-extension.sh
```

The script installs dependencies, type checks, builds with Vite, validates the
output, and writes a timestamped zip to `build/`.

The build carries no backend address, so the same artefact works for every
deployment. To ship a build pre-configured for your own backend:

```bash
echo 'VITE_BACKEND_URL=https://api.example.com' > .env
./scripts/build-extension.sh
```

That only seeds the default on first run; users can still change it from the
options page.

### Backend

```bash
cd backend && npm run build     # compiles to backend/dist/
```

Or build a container:

```bash
cd backend && docker build -t b24-comment-api .
```

## Deploying a Backend Update

1. **Verify locally:**
   ```bash
   npm run lint && npm run typecheck && npm test
   ```

2. **Apply any new migrations** before the new code starts. Check the
   [CHANGELOG](CHANGELOG.md) entry for the release.

3. **Deploy and restart.** The mechanism depends on your host; see
   [DEPLOYMENT.md](DEPLOYMENT.md). With pm2:
   ```bash
   git pull && npm install && cd backend && npm run build
   pm2 restart b24-backend --update-env
   ```

4. **Verify:**
   ```bash
   curl https://api.example.com/health
   curl https://api.example.com/readiness
   ```

   `/readiness` returning `database: false` means the new process cannot reach
   MySQL. Roll back rather than leaving it running: audit writes are silently
   dropped in that state.

## Rolling Back a Deployment

1. **Check out the previous release and rebuild:**
   ```bash
   git checkout <previous-tag>
   npm install && cd backend && npm run build
   pm2 restart b24-backend --update-env
   ```

2. **Migrations are additive**, so a rollback of code does not usually need a
   rollback of schema. A column added by a newer migration is simply unused by
   older code.

3. **Verify with `/readiness`**, then investigate before re-deploying.

## Debugging a Failed Request

1. **Read the popup message.** `NOT_CONFIGURED` means no backend URL is set;
   `TIMEOUT`, `NETWORK_ERROR`, and `API_ERROR` narrow it down further.
2. **Open the service worker console** from `chrome://extensions`, under
   **Inspect views: service worker**.
3. **Check the backend log.** Every request error is logged as structured JSON
   with a code and a message.
4. **Query the audit log:**
   ```sql
   SELECT timestamp, portal_domain, lead_id, action_type, status, failure_reason
   FROM comment_audit_log
   WHERE agent_id = '<memberId>'
   ORDER BY timestamp DESC
   LIMIT 10;
   ```
5. **Check for Bitrix24 rate limiting.** A `BITRIX_ERROR` with
   `QUERY_LIMIT_EXCEEDED` means the portal is throttling; the client already
   retries with backoff and queues per portal.

## Releasing a New Extension Version

1. Build the production zip (see "Building for Production" above).
2. Log in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. Select the Bitrix24 Comment Manager listing.
4. Upload the new zip file.
5. Update the version notes.
6. Submit for review.
7. Monitor the review status (typically 1 to 3 business days).

See `docs/deployment/chrome-web-store.md` for the full submission checklist.
