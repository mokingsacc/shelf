import UIKit
import CoreLocation
import WebKit
import Capacitor

// The phone things a web page can't do, for the page as the Capacitor plugin "ShelfDevice" (registered through
// packageClassList in capacitor.config.json; dev/vendor-ios.mjs keeps it there):
// - keepAwake: the screen doesn't auto-lock while a video plays in Shelf (YouTube pauses its player when it does)
// - dim: Sleep dim, the screen at its lowest while a video's sleep timer runs; the brightness comes back after
// - statusBar: the clock and battery in dark or light, to match Shelf's day or night look
// - locate: where the phone is, once, for sunrise and sunset (asks the first time)
// - youtubeGet: a youtube.com page read as the signed-in account (the sign-in from Sign in to YouTube), so Shelf
//   can see in the watch history where the YouTube app stopped a video after Play locked. Cookies YouTube renews
//   in its answer go back into the jar, like a browser keeps them (sending the old ones on ends the sign-in)
// - youtubeRefresh: a hidden, silent web view opens YouTube's own sign-in link with the same cookie jar for a few
//   seconds. Signed in to Google still, YouTube's sign-in renews by itself with no typing; and YouTube's own page
//   refreshes the cookies the way a browser would. Every few hours on activation, and when the page asks
@objc(ShelfDevicePlugin)
public class ShelfDevicePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate, WKNavigationDelegate {
    public let identifier = "ShelfDevicePlugin"
    public let jsName = "ShelfDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dim", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statusBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "youtubeGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "youtubeRefresh", returnType: CAPPluginReturnPromise)
    ]

    private var awake = false
    private var savedBrightness: CGFloat?
    private var locator: CLLocationManager?
    private var waiting: [CAPPluginCall] = []
    private var keeper: WKWebView?
    private var keeperDone: [(Bool) -> Void] = []
    private var keeperTimer: DispatchWorkItem?
    private static let refreshKey = "shelf.ytRefreshAt"

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(leaving), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.refreshSignIn(force: false) }
        paintBehind(ShelfDevicePlugin.launchLook())
    }

    // What shows before the page has drawn (and during a reload): Shelf's own look, never the web view's default white.
    // The page sends its look and the light hours of the next two weeks; with nothing saved, dark (a dark first frame never hurts).
    static let dark = UIColor(red: 10 / 255, green: 10 / 255, blue: 14 / 255, alpha: 1)
    static func launchLook() -> String {
        let d = UserDefaults.standard
        let mode = d.string(forKey: "shelf.lookMode") ?? "auto"
        if mode == "light" || mode == "dark" { return mode }
        let now = Date().timeIntervalSince1970 * 1000
        if let w = d.array(forKey: "shelf.lightWindows") as? [[Double]], let last = w.last, let first = w.first,
           now >= first[0] - 864e5, now < last[1] + 864e5 {
            return w.contains { $0.count == 2 && now >= $0[0] && now < $0[1] } ? "light" : "dark"
        }
        return "dark"
    }
    private func paintBehind(_ look: String) {
        DispatchQueue.main.async {
            let c: UIColor = look == "light" ? .white : ShelfDevicePlugin.dark
            guard let vc = self.bridge?.viewController else { return }
            vc.view.backgroundColor = c
            vc.view.window?.backgroundColor = c
            if let wv = self.bridge?.webView {
                wv.isOpaque = false
                wv.backgroundColor = c
                wv.scrollView.backgroundColor = c
                if #available(iOS 15.0, *) { wv.underPageBackgroundColor = c }
            }
        }
    }

    private var screen: UIScreen {
        return bridge?.viewController?.view.window?.windowScene?.screen ?? UIScreen.main
    }

    // Leaving Shelf (locking, another app) always gives the brightness back and lets the phone sleep;
    // coming back restores "keep awake" if a video still wants it (the page dims again itself if it should)
    @objc private func leaving() {
        DispatchQueue.main.async {
            self.restoreBrightness()
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }
    @objc private func back() {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = self.awake
            self.refreshSignIn(force: false)
        }
    }

    // ---------- Keeping the YouTube sign-in alive ----------
    // Opens YouTube's sign-in link (Google's page with passive=true: signed in to Google still, it lands on YouTube's
    // home page signed in without asking anything) in a hidden web view on Shelf's cookie jar, lets YouTube's own
    // scripts run a few seconds, then takes it down. At most every 3 hours unless forced. Nothing can play in it
    // (media needs a tap) and nothing shows. done(true) when the page it reached says it's signed in.
    private func refreshSignIn(force: Bool, done: ((Bool) -> Void)? = nil) {
        let last = UserDefaults.standard.double(forKey: ShelfDevicePlugin.refreshKey)
        if !force && Date().timeIntervalSince1970 - last < 3 * 3600 { done?(false); return }
        if keeper != nil { if let d = done { keeperDone.append(d) }; return }
        ShelfSignInPlugin.isSignedIn { signedIn in
            guard signedIn else { done?(false); return }
            DispatchQueue.main.async {
                guard self.keeper == nil, let host = self.bridge?.viewController?.view else { done?(false); return }
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .default()
                if let pool = self.bridge?.webView?.configuration.processPool { config.processPool = pool }
                config.mediaTypesRequiringUserActionForPlayback = .all
                config.allowsInlineMediaPlayback = false
                let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 4, height: 4), configuration: config)
                web.customUserAgent = ShelfSignInPlugin.safariUserAgent // the browser Google saw at sign-in
                web.alpha = 0.01
                web.isUserInteractionEnabled = false
                web.navigationDelegate = self
                host.addSubview(web)
                self.keeper = web
                if let d = done { self.keeperDone.append(d) }
                UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: ShelfDevicePlugin.refreshKey)
                web.load(URLRequest(url: ShelfSignInPlugin.signInURL))
                // Never longer than 20 s, whatever Google shows (a sign-in form means the Google sign-in ended too)
                let timer = DispatchWorkItem { self.endKeeper(ok: false) }
                self.keeperTimer = timer
                DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timer)
            }
        }
    }

    // The hidden web view reached a page: on youtube.com, ask YouTube's own config whether it's signed in
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === keeper, let host = webView.url?.host, host.hasSuffix("youtube.com") else { return }
        webView.evaluateJavaScript("!!(window.ytcfg && ytcfg.get && ytcfg.get('LOGGED_IN'))") { v, _ in
            let ok = (v as? Bool) ?? false
            // A few seconds more on the page, so YouTube's scripts finish renewing the cookies
            DispatchQueue.main.asyncAfter(deadline: .now() + (ok ? 4 : 0)) { self.endKeeper(ok: ok) }
        }
    }

    private func endKeeper(ok: Bool) {
        guard let web = keeper else { return }
        keeperTimer?.cancel()
        keeperTimer = nil
        web.stopLoading()
        web.navigationDelegate = nil
        web.removeFromSuperview()
        keeper = nil
        let waiting = keeperDone
        keeperDone = []
        waiting.forEach { $0(ok) }
    }

    @objc func youtubeRefresh(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.refreshSignIn(force: true) { call.resolve(["signedIn": $0]) }
        }
    }

    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            self.awake = on
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve(["on": on])
        }
    }

    @objc func dim(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            if on {
                if self.savedBrightness == nil { self.savedBrightness = self.screen.brightness }
                self.screen.brightness = 0.0
            } else {
                self.restoreBrightness()
            }
            call.resolve(["on": on])
        }
    }

    private func restoreBrightness() {
        if let b = savedBrightness {
            screen.brightness = b
            savedBrightness = nil
        }
    }

    @objc func statusBar(_ call: CAPPluginCall) {
        let style = call.getString("style") ?? "default"
        if let look = call.getString("look") {
            let d = UserDefaults.standard
            d.set(call.getString("mode") ?? "auto", forKey: "shelf.lookMode")
            let w = (call.getArray("windows") ?? []).compactMap { ($0 as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue } }
            d.set(w, forKey: "shelf.lightWindows")
            paintBehind(look)
        }
        DispatchQueue.main.async {
            guard let bridge = self.bridge else { return call.reject("Shelf's screen isn't ready") }
            bridge.statusBarStyle = style == "dark" ? .darkContent : style == "light" ? .lightContent : .default
            bridge.viewController?.setNeedsStatusBarAppearanceUpdate()
            call.resolve(["style": style])
        }
    }

    @objc func locate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let m = self.locator ?? CLLocationManager()
            m.delegate = self
            m.desiredAccuracy = kCLLocationAccuracyKilometer
            self.locator = m
            switch m.authorizationStatus {
            case .denied, .restricted:
                call.reject("Location is off for Shelf. Turn it on in Settings > Shelf > Location.", "denied")
            case .notDetermined:
                self.waiting.append(call)
                m.requestWhenInUseAuthorization()
            default:
                self.waiting.append(call)
                m.requestLocation()
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .notDetermined:
            return
        case .denied, .restricted:
            finish { $0.reject("Location is off for Shelf. Turn it on in Settings > Shelf > Location.", "denied") }
        default:
            if !waiting.isEmpty { manager.requestLocation() }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let c = locations.last?.coordinate else { return }
        finish { $0.resolve(["lat": c.latitude, "lon": c.longitude]) }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish { $0.reject("The phone couldn't work out where you are: " + error.localizedDescription, "failed") }
    }

    // ---------- Reading youtube.com as the account ----------
    // youtube.com pages only, sent with the account's YouTube cookies from the web view's jar
    static let desktopUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    // Cookies a youtube.com answer sets (renewed sign-in tokens, mostly) go into both jars Shelf has: the web view's
    // (the sheet's sign-in, the player) and iOS's own (Capacitor's native reads), so no read sends old ones later
    static func keepCookies(from http: HTTPURLResponse) {
        guard let u = http.url, u.host?.hasSuffix("youtube.com") == true, let fields = http.allHeaderFields as? [String: String] else { return }
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: fields, for: u).filter { $0.domain.hasSuffix("youtube.com") }
        if fresh.isEmpty { return }
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default().httpCookieStore
            for c in fresh {
                store.setCookie(c)
                HTTPCookieStorage.shared.setCookie(c)
            }
        }
    }

    // Follows a redirect only while it stays on www.youtube.com (with the same cookies). One that leaves for Google's
    // sign-in means YouTube no longer accepts the sign-in: the page gets the redirect itself (3xx) and where it went,
    // instead of Google's sign-in page, and YouTube's cookies never go to another site
    final class Hop: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            ShelfDevicePlugin.keepCookies(from: response)
            guard request.url?.host == "www.youtube.com" else { return completionHandler(nil) }
            var next = request
            next.httpShouldHandleCookies = false
            if let cookie = task.originalRequest?.value(forHTTPHeaderField: "Cookie") { next.setValue(cookie, forHTTPHeaderField: "Cookie") }
            completionHandler(next)
        }
    }
    private static let hop = Hop()
    private static let session = URLSession(configuration: .default, delegate: hop, delegateQueue: nil)

    @objc func youtubeGet(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s), url.scheme == "https", url.host == "www.youtube.com" else {
            return call.reject("Only youtube.com pages")
        }
        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                let mine = cookies.filter { $0.domain.hasSuffix("youtube.com") }
                var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
                req.httpShouldHandleCookies = false
                for (k, v) in HTTPCookie.requestHeaderFields(with: mine) { req.setValue(v, forHTTPHeaderField: k) }
                req.setValue(ShelfDevicePlugin.desktopUserAgent, forHTTPHeaderField: "User-Agent")
                req.setValue("en-GB,en;q=0.9", forHTTPHeaderField: "Accept-Language")
                ShelfDevicePlugin.session.dataTask(with: req) { data, resp, err in
                    if let err = err { return call.reject("YouTube didn't answer: " + err.localizedDescription) }
                    let http = resp as? HTTPURLResponse
                    if let http = http { ShelfDevicePlugin.keepCookies(from: http) }
                    let status = http?.statusCode ?? 0
                    // Where the answer came from, or where a redirect wanted to go (accounts.google.com: sign-in ended)
                    let away = (http?.allHeaderFields["Location"] as? String).flatMap { URL(string: $0, relativeTo: http?.url) }?.host
                    let host = (status >= 300 && status < 400 ? away : nil) ?? http?.url?.host ?? ""
                    call.resolve(["status": status, "data": String(decoding: data ?? Data(), as: UTF8.self), "signedIn": mine.contains { ShelfSignInPlugin.loginCookies.contains($0.name) }, "host": host])
                }.resume()
            }
        }
    }

    private func finish(_ each: (CAPPluginCall) -> Void) {
        let calls = waiting
        waiting = []
        calls.forEach(each)
    }
}
