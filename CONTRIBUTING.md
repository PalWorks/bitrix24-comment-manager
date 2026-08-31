# Contributing

Thanks for considering a contribution. This project is small and the bar is
practical: does it work, is it tested, does it stay honest about what it does.

## Getting set up

```bash
git clone https://github.com/<your-fork>/bitrix24-comment-manager.git
cd bitrix24-comment-manager
npm install
npm test
```

The full suite runs without MySQL and without a Bitrix24 portal. If it is not
green on a fresh clone, that is a bug worth reporting on its own.

For a working environment against a real portal, follow [docs/SETUP.md](docs/SETUP.md).

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
```

All three must pass. CI runs the same three plus both builds.

## What makes a change easy to accept

- **One concern per pull request.** A bug fix and a refactor in the same diff
  take several times longer to review.
- **A test that fails before your change and passes after.** For a bug fix this
  is the clearest way to show the bug was real.
- **Comments that explain why, not what.** The code already says what it does.
- **Documentation updated in the same commit.** If you change behaviour that
  README, DEPLOYMENT, or docs/SETUP describes, change the description too.

## Project conventions

- TypeScript throughout, strict mode, four space indentation.
- Backend imports use the `.js` extension, as Node ESM requires. The build and
  the test runner both resolve those to the `.ts` sources.
- Errors go through the typed hierarchy in `backend/src/utils/errors.ts`. A route
  should throw `NotFoundError`, not construct a status code by hand.
- Logging goes through `backend/src/utils/logger.ts`. Never log a comment body, a
  token, or a secret.
- The extension talks to the backend only from the service worker. The popup and
  the options page send messages; they do not call `fetch` for authenticated
  endpoints.

## Areas where help is especially welcome

- Support for deals, contacts, and companies, not only leads.
- Moving the per process stores to Redis so the backend can scale horizontally.
- Reading the real Bitrix24 timeline into the popup instead of a session local
  list.
- Testing against Bitrix24 versions and regional portals we do not have access
  to. Bug reports from those are valuable even without a fix.

## Reporting bugs

Open an issue with the version of Chrome, the kind of Bitrix24 portal (cloud with
which domain, or self hosted), what you expected, what happened, and any relevant
backend log lines. Redact tokens and secrets.

For anything security sensitive, do not open an issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
