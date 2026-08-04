#!/usr/bin/env bash
# Bundles the compiled packages and inlines them into a single self-contained page.
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD=$(find node_modules/.pnpm -name esbuild -type f -path '*/bin/*' | head -1)

"$ESBUILD" demo/entry.ts \
  --bundle --format=iife --global-name=WEA \
  --platform=browser --target=es2022 \
  --alias:node:crypto=./demo/crypto-shim.js \
  --inject:./demo/buffer-shim.js \
  --minify --outfile=demo/bundle.js

python3 - <<'PY'
html = open('demo/index.html').read()
bundle = open('demo/bundle.js').read()
# A literal closing script tag in the bundle would end the inline block early.
assert '</scr' + 'ipt>' not in bundle, 'bundle would break out of its script tag'
assert '/*__BUNDLE__*/' in html, 'placeholder missing from index.html'
open('demo/page.html', 'w').write(html.replace('/*__BUNDLE__*/', bundle))
print('demo/page.html written')
PY
