#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTENSION_DIR="$PROJECT_ROOT/extension"
DIST_DIR="$EXTENSION_DIR/dist"
OUTPUT_DIR="$PROJECT_ROOT/build"

echo "=== Bitrix24 Comment Manager: Extension Build ==="

if [ -z "${VITE_BACKEND_URL:-}" ]; then
    echo "VITE_BACKEND_URL is not set."
    echo "Building a portable extension: users choose their backend on first run."
    echo "To pre-configure one, set VITE_BACKEND_URL or put it in the root .env."
    echo ""
fi

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
