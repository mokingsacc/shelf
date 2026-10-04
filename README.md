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

## For Claude

- `index.html` and `icon.png` are the web app (built). Source and tests are in `dev/`: `node dev/build.mjs`, `npm test` (node unit tests + Playwright e2e of the done test with a faked iPhone shell and internet in `dev/test/fakenet.mjs`). `node dev/test/preview.mjs <outdir>` saves phone screenshots.
- Look: "Day Sheet" (Archivo + Azeret Mono, flat yellow/cobalt/black bands, thick rules). Dark mode is the same sheet with the lights down; podcasts always use the night player.
- GitHub Pages serves the `gh-pages` branch: after pushing `main`, also `git push origin main:gh-pages`.
- `ios/` is the Capacitor shell (loads the Pages site via `server.url`). Plugins are vendored in `ios/vendor` so Xcode needs no npm; after `npx cap sync ios` run `node dev/vendor-ios.mjs`.
