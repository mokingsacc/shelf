#!/bin/sh
# Runs only the W (Apple Watch) block of e2e.mjs, for quick iterations
cd "$(dirname "$0")/../.."
S=$(grep -n "== W Apple Watch" dev/test/e2e.mjs | cut -d: -f1); E=$(grep -n "== Mac browser (no app)" dev/test/e2e.mjs | cut -d: -f1)
{ head -37 dev/test/e2e.mjs | sed 's#8765#8766#'; echo 'let ctx, p;'; sed -n "${S},$((E-1))p" dev/test/e2e.mjs; tail -6 dev/test/e2e.mjs; } > dev/test/.w.mjs
node dev/test/.w.mjs; r=$?; rm -f dev/test/.w.mjs; exit $r
