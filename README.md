# Shelf

YouTube without the noise, laid out like your day. Your channels sit in bands (Medicine, Entertainment, Sleep) showing only what's new or unfinished. Every video remembers where you stopped, every player has a one-tap sleep timer, and Sleep podcasts keep playing on the lock screen. No recommendations.

Open it in a browser: https://mokingsacc.github.io/shelf/

## Put Shelf on your iPhone (once)

**Quickest:** plug your iPhone into your Mac, open Terminal and paste:

```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/mokingsacc/shelf/main/install-iphone.sh)"
```

It downloads Shelf, builds it with Xcode and installs it on the phone, and says in plain words what to do if anything stops it. Or do it by hand:


1. On your Mac, install **Xcode** from the App Store and open it once so it finishes installing. Then on this page press the green **Code** button, **Download ZIP**, and unzip it.
2. Double-click `ios/App/App.xcodeproj`. Plug in your iPhone, unlock it and tap **Trust**. At the top of Xcode pick your iPhone, then press **▶ Run**. If Xcode asks you to sign in or pick a team: click the blue **App** icon on the left, open **Signing & Capabilities**, tick **Automatically manage signing** and choose your name under **Team**, then press Run again.
3. On the iPhone: if it asks for **Developer Mode**, turn it on in Settings > Privacy & Security and restart. If it says **Untrusted Developer**, go to Settings > General > VPN & Device Management, tap your Apple ID, tap **Trust**. Open **Shelf**.

Updates arrive by themselves: the app loads this website, so there's nothing to reinstall. With a free Apple ID, repeat step 2 every 7 days; with a paid developer account, once a year.

## YouTube Premium without ads (once)

The player only skips ads when it can see your Premium account. Two switches, both in plain sight:

1. On the iPhone: **Settings > Shelf > Allow Cross-Website Tracking** on. (Shelf tracks nothing; this lets the YouTube player inside Shelf see YouTube's own sign-in cookie, which iOS otherwise hides from it.) Then close Shelf and open it again.
2. In Shelf, tap the self-check corner and **Sign in to YouTube**. Google's sign-in opens in a sheet; when it reaches YouTube's home page it closes by itself and the self-check says "Signed in to YouTube".

If Google refuses to sign in inside an app ("this browser or app may not be secure"), the player still works with ads; for Premium, tap **Lock screen ↗** in the player to open the video in the YouTube app at your spot.

## Playing with the phone locked

YouTube stops its embedded player (in any app) when the phone locks, Premium or not. **Lock screen ↗** in the player opens the video in the YouTube app at the same second, where Premium keeps playing locked. Back in Shelf, your place moves on by the time you were away (at that video's speed, never past the end), with an Undo. While a video plays in Shelf the screen stays on, so it doesn't auto-lock.

## For Claude

- `index.html` and `icon.png` are the web app (built). Source and tests are in `dev/`: `node dev/build.mjs`, `npm test` (node unit tests + Playwright e2e of the done test with a faked iPhone shell and internet in `dev/test/fakenet.mjs`). `node dev/test/preview.mjs <outdir>` saves phone screenshots.
- Look (v3, spec in the project's `areas/youtube-resume/v3/`): "Day Sheet" (Archivo + Azeret Mono, flat yellow/cobalt/black bands, thick rules), a tab bar (Today, Courses, Search), bottom sheets that swipe down, 44 px targets. Home orders itself by the hour (`hourNow()`; tests set `window.__hour`): after 21:30 Sleep comes first, Continue becomes Bedtime and a 45-minute timer starts with the podcast. Speed is remembered per channel and per podcast (`prefs.rates`), Marks live in `dev/src/marks.js`, the exam clock in `Courses.EXAM`.
- GitHub Pages serves the `gh-pages` branch: after pushing `main`, also `git push origin main:gh-pages`.
- `ios/` is the Capacitor shell (loads the Pages site via `server.url`). Plugins are vendored in `ios/vendor` so Xcode needs no npm; after `npx cap sync ios` run `node dev/vendor-ios.mjs`.
- `ios/App/App/ShelfSignIn.swift` is Shelf's one native plugin (`ShelfSignIn`: status, signIn, signOut, openSettings): a sheet with Google's sign-in that shares the web view's cookie store, so the embedded player sees Mo's YouTube Premium. It is listed in `packageClassList` (vendor-ios.mjs keeps it there) and in the Xcode project. `NSCrossWebsiteTrackingUsageDescription` in Info.plist gives the app the Settings switch that turns WebKit's third-party-cookie blocking off for the player. `dev/src/native.js` reads its state (`Native.ytAccount`); the fake shell in `dev/test/fakenet.mjs` has `shell` options for it.
