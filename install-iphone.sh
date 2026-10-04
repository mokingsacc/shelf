#!/bin/bash
# Puts Shelf on the iPhone plugged into this Mac. Run it again any time (free Apple ID: every 7 days).
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/mokingsacc/shelf/main/install-iphone.sh)"
set -o pipefail

DIR="$HOME/Shelf"
LOG="$DIR/install-log.txt"
BUNDLE="com.mokingsacc.shelf"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; [ -n "$2" ] && printf '  %s\n' "$2"; printf '\nIf you are stuck, send Claude the file %s\n' "$LOG"; exit 1; }

say "Installing Shelf on your iPhone"

# 1. Xcode
command -v xcodebuild >/dev/null 2>&1 || fail "Xcode isn't installed." "Install Xcode from the App Store, open it once, then run this again."
if ! xcode-select -p 2>/dev/null | grep -q "Xcode.*\.app"; then
  fail "Your Mac is pointing at the small command-line tools, not Xcode." "Run this once, type your Mac password, then run the installer again:
  sudo xcode-select -s /Applications/Xcode.app"
fi
xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 || fail "Xcode hasn't finished setting up." "Open Xcode once and let it install its components, then run this again."
ok "Xcode $(xcodebuild -version 2>/dev/null | head -1 | awk '{print $2}')"

# 2. Latest Shelf
mkdir -p "$DIR"; : > "$LOG"
if [ -d "$DIR/repo/.git" ]; then
  git -C "$DIR/repo" fetch -q --depth 1 origin main >>"$LOG" 2>&1 && git -C "$DIR/repo" reset -q --hard origin/main >>"$LOG" 2>&1 || fail "Couldn't download the latest Shelf." "Check your internet and try again."
else
  rm -rf "$DIR/repo"
  git clone -q --depth 1 https://github.com/mokingsacc/shelf.git "$DIR/repo" >>"$LOG" 2>&1 || fail "Couldn't download Shelf." "Check your internet and try again."
fi
ok "Downloaded the latest Shelf"

# 3. Your Apple ID (signing team)
TEAM="${SHELF_TEAM:-}"
if [ -z "$TEAM" ]; then
  # The team is the OU of your "Apple Development" certificate, which Xcode makes when you add your Apple ID
  if security find-certificate -c "Apple Development" -p >/tmp/shelf-cert.pem 2>/dev/null; then
    TEAM=$(openssl x509 -noout -subject -in /tmp/shelf-cert.pem 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p')
  fi
  rm -f /tmp/shelf-cert.pem
fi
if [ -z "$TEAM" ]; then
  TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]\{10\}\);.*/\1/p' | head -1)
fi
if [ -z "$TEAM" ]; then
  open -a Xcode 2>/dev/null
  fail "Xcode doesn't know your Apple ID yet." "In Xcode: Xcode menu > Settings > Accounts > + > Apple ID, sign in, then click 'Manage Certificates' > + > Apple Development. Then run this again."
fi
ok "Signing as team $TEAM"

# 4. The iPhone
xcrun devicectl list devices --json-output /tmp/shelf-devices.json >>"$LOG" 2>&1
cat > /tmp/shelf-pick.py <<'PY'
import json
try:
    d = json.load(open('/tmp/shelf-devices.json'))['result']['devices']
except Exception:
    d = []
best = None
for x in d:
    hp, cp, dp = x.get('hardwareProperties', {}), x.get('connectionProperties', {}), x.get('deviceProperties', {})
    if hp.get('platform') != 'iOS' or hp.get('deviceType') not in ('iPhone', 'iPad'):
        continue
    score = (cp.get('transportType') == 'wired') * 2 + (cp.get('tunnelState') == 'connected')
    if best is None or score > best[0]:
        best = (score, hp.get('udid', ''), dp.get('name', 'iPhone'))
print((best[1] + ' ' + best[2]) if best else '')
PY
PICK=$(/usr/bin/python3 /tmp/shelf-pick.py 2>>"$LOG")
UDID=${PICK%% *}; NAME=${PICK#* }
[ -n "$UDID" ] || fail "Can't see your iPhone." "Plug it in with a cable, unlock it, tap 'Trust This Computer' if asked, then run this again."
ok "Found $NAME"

# 5. Build
say "Building Shelf (the first time takes a few minutes)…"
DERIVED="$DIR/build"
build() {
  xcodebuild -project "$DIR/repo/ios/App/App.xcodeproj" -scheme App -configuration Debug \
    -destination "id=$UDID" -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
    DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$1" build >>"$LOG" 2>&1
}
if ! build "$BUNDLE"; then
  if grep -qiE "not available|cannot be registered|already in use" "$LOG"; then
    BUNDLE="$BUNDLE.$(echo "$TEAM" | tr 'A-Z' 'a-z')"; echo "--- retry with $BUNDLE" >>"$LOG"
    build "$BUNDLE" || BUILD_FAILED=1
  else BUILD_FAILED=1; fi
fi
if [ -n "$BUILD_FAILED" ]; then
  if grep -qi "Developer Mode" "$LOG"; then fail "Developer Mode is off on your iPhone." "On the iPhone: Settings > Privacy & Security > Developer Mode > On. It restarts; unlock it, then run this again."; fi
  if grep -qiE "No Accounts|No signing certificate|requires a development team|No profiles" "$LOG"; then fail "Xcode couldn't sign Shelf with your Apple ID." "In Xcode: Settings > Accounts, check your Apple ID is listed (sign in again if it says so). Then run this again."; fi
  if grep -qiE "is not supported by|deployment target|not installed|Platform.*not.*installed|iOS [0-9.]+ is not installed" "$LOG"; then fail "Xcode needs the iOS support files for your iPhone." "Open Xcode > Settings > Components and install the iOS platform, then run this again."; fi
  if grep -qiE "Could not resolve package|package resolution|github.com" "$LOG"; then fail "Xcode couldn't download a building block from GitHub." "Check your internet and run this again."; fi
  grep -E "error:" "$LOG" | head -5
  fail "The build failed." "The lines above say why."
fi
APP=$(ls -d "$DERIVED"/Build/Products/Debug-iphoneos/*.app 2>/dev/null | head -1)
[ -n "$APP" ] || fail "The build finished but the app file is missing."
ok "Built"

# 6. Install and open
say "Installing on $NAME…"
xcrun devicectl device install app --device "$UDID" "$APP" >>"$LOG" 2>&1 || {
  grep -qi "Developer Mode" "$LOG" && fail "Developer Mode is off on your iPhone." "On the iPhone: Settings > Privacy & Security > Developer Mode > On. It restarts; unlock it, then run this again."
  fail "Couldn't install on the iPhone." "Unlock the iPhone, keep it plugged in, and run this again."
}
ok "Installed"
if xcrun devicectl device process launch --device "$UDID" "$BUNDLE" >>"$LOG" 2>&1; then
  ok "Shelf is open on your iPhone"
else
  printf '\n  One last step on the iPhone (first time only):\n'
  printf '  Settings > General > VPN & Device Management > tap your Apple ID > Trust.\n'
  printf '  Then open Shelf from the Home Screen.\n'
fi
say "Done. Updates arrive by themselves from now on."
printf '  With a free Apple ID, run the same command again every 7 days.\n\n'
