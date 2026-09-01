#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_DIR="$PROJECT_ROOT/extension"
DIST_DIR="$EXTENSION_DIR/dist"
OUTPUT_DIR="$PROJECT_ROOT/build"

echo "=== Bitrix24 Comment Manager: Extension Build ==="

echo "Step 1: Installing dependencies..."
cd "$EXTENSION_DIR"
npm ci --silent

echo "Step 2: Running TypeScript type check..."
npm run typecheck

echo "Step 3: Building extension..."
npm run build

if [ ! -d "$DIST_DIR" ]; then
    echo "ERROR: dist/ directory not found after build."
    exit 1
fi

echo "Step 4: Validating dist/ contents..."
REQUIRED_FILES=("manifest.json")
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$DIST_DIR/$file" ]; then
        echo "ERROR: Required file missing from dist/: $file"
        exit 1
    fi
done

# Vite bakes VITE_BACKEND_URL in from the shell OR from any root .env, .env.local
# or .env.production, so checking the shell variable alone is not enough. Ask Vite
# itself what it resolved, then confirm that value is not in the shipping bundle.
BAKED_URL=$(cd "$EXTENSION_DIR" && node -e "
  const { loadEnv } = require('vite');
  process.stdout.write(loadEnv('production', '$PROJECT_ROOT', 'VITE_').VITE_BACKEND_URL || '');
")

if [ -n "$BAKED_URL" ] && ! grep -rqF "$BAKED_URL" "$DIST_DIR"; then
    echo "NOTE: Vite resolved VITE_BACKEND_URL=$BAKED_URL but it is absent from dist/."
    BAKED_URL=""
fi

if [ -n "$BAKED_URL" ]; then
    if [ "${ALLOW_BAKED_BACKEND_URL:-0}" = "1" ]; then
        echo "Pre-configured build: default backend is $BAKED_URL"
        echo "Users can still change it on the options page."
    else
        echo "ERROR: this build has a backend URL baked in: $BAKED_URL"
        echo ""
        echo "A public Chrome Web Store build must ship with no backend, so every"
        echo "installation is asked for its own on first run. This value came from"
        echo "the shell or from a root .env / .env.local / .env.production file."
        echo ""
        echo "To ship a portable build:  move those files aside and rebuild."
        echo "To ship this on purpose:   ALLOW_BAKED_BACKEND_URL=1 $0"
        exit 1
    fi
else
    echo "Portable build: no backend baked in, users configure one on first run."
fi

# The support URL is the mirror image of the check above: the backend URL must
# NOT be here, and this one must. It is the address the Get help form and the
# hosting waitlist post to, and when it is missing the options page hides both
# and says nothing, so the failure ships looking exactly like a success. It used
# to be passed on the command line, which is precisely how that happened.
SUPPORT_URL=$(cd "$EXTENSION_DIR" && node -e "
  const { loadEnv } = require('vite');
  process.stdout.write(loadEnv('production', '$PROJECT_ROOT', 'VITE_').VITE_SUPPORT_URL || '');
")

if [ -z "$SUPPORT_URL" ]; then
    echo "NOTE: no VITE_SUPPORT_URL. The Get help form is hidden and points at the issue tracker."
    echo "      That is correct for a fork. For the published build, set it in .env.production."
elif grep -rqF "$SUPPORT_URL" "$DIST_DIR"; then
    echo "Support service: $SUPPORT_URL"
else
    echo "ERROR: VITE_SUPPORT_URL resolved to $SUPPORT_URL but it is absent from dist/."
    echo ""
    echo "The build would ship with the Get help form silently hidden. This means"
    echo "the value did not reach the bundle: check that .env.production is being"
    echo "read and that the build ran after it changed."
    exit 1
fi

echo "Step 5: Creating zip bundle..."
mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
VERSION=$(node -p "require('$EXTENSION_DIR/manifest.json').version")
ZIP_NAME="bitrix24-comment-manager-v${VERSION}-${TIMESTAMP}.zip"
cd "$DIST_DIR"
zip -r "$OUTPUT_DIR/$ZIP_NAME" . -x "*.map" -x ".vite/*"

BUNDLE_SIZE=$(du -sh "$OUTPUT_DIR/$ZIP_NAME" | cut -f1)
echo ""
echo "=== Build Complete ==="
echo "Bundle: $OUTPUT_DIR/$ZIP_NAME"
echo "Size:   $BUNDLE_SIZE"

BUNDLE_BYTES=$(stat -c%s "$OUTPUT_DIR/$ZIP_NAME" 2>/dev/null || stat -f%z "$OUTPUT_DIR/$ZIP_NAME" 2>/dev/null)
MAX_BYTES=$((10 * 1024 * 1024))
if [ "$BUNDLE_BYTES" -gt "$MAX_BYTES" ]; then
    echo "WARNING: Bundle exceeds Chrome Web Store 10MB limit!"
    exit 1
else
    echo "Status: Within Chrome Web Store size limit (< 10MB)"
fi
