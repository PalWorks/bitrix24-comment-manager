#!/usr/bin/env bash
# Watchdog for the b24-backend process on hosts without a service manager.
# Schedule on a cron every few minutes, for example:
#   */5 * * * * /bin/bash /path/to/repo/scripts/start-b24-backend.sh
#
# Set APP_DIR to the backend directory of your checkout, or export it beforehand.

set -uo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/b24-backend/backend}"
PROCESS_NAME="${PROCESS_NAME:-b24-backend}"

# Load nvm when present so cron jobs find the right node.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
fi

cd "$APP_DIR" || exit 1

if ! pm2 describe "$PROCESS_NAME" > /dev/null 2>&1; then
    pm2 start dist/server.js --name "$PROCESS_NAME"
    pm2 save
fi
