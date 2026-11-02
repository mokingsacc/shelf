#!/bin/bash
# Builds Shelf's watch app for the simulator, opens each screen in demo mode (-demo -screen <name>) on a 42 mm
# Apple Watch Series 11, and saves a screenshot of each to shots/, then to the ci-shots branch (watch/<name>.png).
set -o pipefail
mkdir -p shots
TYPE=$(xcrun simctl list devicetypes | grep -E "Apple Watch Series 11 \(42mm\)" | head -1 | sed -E 's/.*\((com\.apple[^)]*)\).*/\1/')
[ -n "$TYPE" ] || TYPE=$(xcrun simctl list devicetypes | grep -E "Apple Watch Series 1[01] \(4[12]mm\)" | head -1 | sed -E 's/.*\((com\.apple[^)]*)\).*/\1/')
RUNTIME=$(xcrun simctl list runtimes | grep -E "^watchOS" | tail -1 | sed -E 's/.* - (com\.apple[^ ]*).*/\1/')
if [ -z "$RUNTIME" ]; then
  echo "No watchOS simulator runtime; downloading it"; xcodebuild -downloadPlatform watchOS >/dev/null 2>&1
  RUNTIME=$(xcrun simctl list runtimes | grep -E "^watchOS" | tail -1 | sed -E 's/.* - (com\.apple[^ ]*).*/\1/')
fi
echo "Device type: $TYPE  Runtime: $RUNTIME"
[ -n "$TYPE" ] && [ -n "$RUNTIME" ] || { echo "::warning::No watch simulator available for screenshots"; exit 0; }
UDID=$(xcrun simctl create "Shelf Watch" "$TYPE" "$RUNTIME") || exit 1
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
xcodebuild -project ios/App/App.xcodeproj -scheme ShelfWatch -configuration Debug -sdk watchsimulator \
  -destination "id=$UDID" -derivedDataPath build-watch CODE_SIGNING_ALLOWED=NO build > watch-build.log 2>&1 || {
  grep -E "error:" watch-build.log | sort -u | head -25 | while IFS= read -r l; do echo "::error::${l#*/ios/}"; done; tail -30 watch-build.log; exit 1; }
APP=$(ls -d build-watch/Build/Products/Debug-watchsimulator/*.app | head -1)
BID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist")
xcrun simctl install "$UDID" "$APP" || exit 1
xcrun simctl status_bar "$UDID" override --time "9:41" >/dev/null 2>&1 || true
shot() {  # name, then launch arguments
  local name=$1; shift
  xcrun simctl terminate "$UDID" "$BID" >/dev/null 2>&1
  xcrun simctl launch "$UDID" "$BID" -demo "$@" >/dev/null || { echo "::warning::$name did not launch"; return; }
  sleep 4
  xcrun simctl io "$UDID" screenshot "shots/$name.png" >/dev/null 2>&1 && echo "shot $name"
}
shot today -screen today
shot today-playing -playing -screen today
shot sections -screen sections
shot section -screen section
shot channel -screen channel
shot playon -screen playon
shot playon-sleep -screen playon-sleep
shot now -playing -screen now
shot now-watch -screen now-watch
shot speed -playing -screen speed
shot sleep -playing -screen sleep
shot more -playing -screen more
shot notes -playing -screen notes
shot courses -screen courses
shot course -screen course
shot allcourses -screen allcourses
shot step2 -screen step2
shot check -screen check
shot away -away -screen today
shot now-away -away -playing -screen now
shot now-next -playing -ended -screen now
shot now-message -playing -message -screen now
shot check-away -away -screen check
shot closed -closed -screen today
shot now-closed -closed -playing -screen now
shot now-hold -playing -holding -screen now
shot now-watch-hold -holding -screen now-watch
shot playon-closed -closed -screen playon
shot check-closed -closed -screen check
# Crash reports, if any screen crashed
ls ~/Library/Logs/DiagnosticReports 2>/dev/null | grep -i shelf && echo "::warning::The watch app crashed on a screen (see DiagnosticReports)"
# To the ci-shots branch, so they can be fetched without the artifact API
if [ -n "$GH_TOKEN" ] && ls shots/*.png >/dev/null 2>&1; then
  D=$(mktemp -d); mkdir -p "$D/watch"; cp shots/*.png "$D/watch/"; cd "$D"
  git init -q; git checkout -q -b ci-shots
  git config user.name "github-actions"; git config user.email "github-actions@users.noreply.github.com"
  echo "Watch screenshots from $GITHUB_SHA" > README.md
  git add -A; git commit -qm "Watch screenshots for $GITHUB_SHA"
  git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" ci-shots && echo "pushed to ci-shots"
fi
exit 0
