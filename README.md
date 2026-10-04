# Shelf

YouTube without the noise: paste a link and Shelf remembers where you stopped. The bigger iPhone version (sections, channels, sleep timer, Sleep podcasts on the lock screen) is being built here.

Open it in a browser: https://mokingsacc.github.io/shelf/

## Put Shelf on your iPhone (once)

1. On your Mac, install **Xcode** from the App Store and open it once so it finishes installing. Then on this page press the green **Code** button, **Download ZIP**, and unzip it.
2. Double-click `ios/App/App.xcodeproj`. Plug in your iPhone, unlock it and tap **Trust**. At the top of Xcode pick your iPhone, then press **▶ Run**. If Xcode asks you to sign in or pick a team: click the blue **App** icon on the left, open **Signing & Capabilities**, tick **Automatically manage signing** and choose your name under **Team**, then press Run again.
3. On the iPhone: if it asks for **Developer Mode**, turn it on in Settings > Privacy & Security and restart. If it says **Untrusted Developer**, go to Settings > General > VPN & Device Management, tap your Apple ID, tap **Trust**. Open **Shelf**.

Updates arrive by themselves: the app loads this website, so there's nothing to reinstall. With a free Apple ID, repeat step 2 every 7 days; with a paid developer account, once a year.

## For Claude

- `index.html` and `icon.png` are the web app (built). Source and tests are in `dev/`: `node dev/build.mjs`, `node dev/test/core.test.cjs`, `node dev/test/e2e.mjs` (Playwright).
- GitHub Pages serves the `gh-pages` branch: after pushing `main`, also `git push origin main:gh-pages`.
- `ios/` is the Capacitor shell (loads the Pages site via `server.url`). Plugins are vendored in `ios/vendor` so Xcode needs no npm; after `npx cap sync ios` run `node dev/vendor-ios.mjs`.
