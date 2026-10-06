import UIKit
import AVFoundation
import CoreLocation
import WebKit
import Capacitor

// The phone things a web page can't do, for the page as the Capacitor plugin "ShelfDevice" (registered through
// packageClassList in capacitor.config.json; dev/vendor-ios.mjs keeps it there):
// - keepAwake: the screen doesn't auto-lock while a video plays in Shelf (YouTube pauses its player when it does)
// - dim: Sleep dim, the screen at its lowest while a video's sleep timer runs; the brightness comes back after
// - statusBar: the clock and battery in dark or light, to match Shelf's day or night look
// - locate: where the phone is, once, for sunrise and sunset (asks the first time)
// - stopOthersAfter: Shelf's sleep timer for the YouTube app after Play locked. Shelf stays awake in the background
//   with silent sound that mixes with YouTube's; when the time is up it takes the sound over, which pauses YouTube
//   the way a phone call does
// - youtubeGet: a youtube.com page read as the signed-in account (the sign-in from Sign in to YouTube), so Shelf
//   can see in the watch history where the YouTube app stopped a video after Play locked
@objc(ShelfDevicePlugin)
public class ShelfDevicePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "ShelfDevicePlugin"
    public let jsName = "ShelfDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dim", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statusBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "youtubeGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopOthersAfter", returnType: CAPPluginReturnPromise)
    ]

    private var awake = false
    private var savedBrightness: CGFloat?
    private var locator: CLLocationManager?
    private var waiting: [CAPPluginCall] = []

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(leaving), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
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
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = self.awake }
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

    // youtube.com pages only, sent with the account's YouTube cookies from the web view's jar
    static let desktopUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
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
                URLSession.shared.dataTask(with: req) { data, resp, err in
                    if let err = err { return call.reject("YouTube didn't answer: " + err.localizedDescription) }
                    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    call.resolve(["status": status, "data": String(decoding: data ?? Data(), as: UTF8.self), "signedIn": mine.contains { ShelfSignInPlugin.loginCookies.contains($0.name) }])
                }.resume()
            }
        }
    }

    // ---- Sleep timer for the YouTube app ----
    private var silence: AVAudioPlayer?
    private var sleepTimer: Timer?

    @objc func stopOthersAfter(_ call: CAPPluginCall) {
        let minutes = call.getDouble("minutes") ?? 0
        DispatchQueue.main.async {
            self.cancelSleep()
            guard minutes > 0 else { return call.resolve(["on": false]) }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)
                let p = try AVAudioPlayer(data: ShelfDevicePlugin.silentWav())
                p.numberOfLoops = -1
                p.volume = 0
                p.play()
                self.silence = p
            } catch {
                return call.reject("Shelf couldn't stay awake for the timer: " + error.localizedDescription)
            }
            self.sleepTimer = Timer.scheduledTimer(withTimeInterval: minutes * 60, repeats: false) { [weak self] _ in self?.timeUp() }
            call.resolve(["on": true])
        }
    }

    // Time's up: Shelf's own (silent) sound, not mixed, interrupts YouTube; then Shelf lets go without telling it to resume
    private func timeUp() {
        sleepTimer = nil
        silence?.stop()
        silence = nil
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            let p = try AVAudioPlayer(data: ShelfDevicePlugin.silentWav())
            p.volume = 0
            p.play()
            silence = p
        } catch {}
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            self.silence?.stop()
            self.silence = nil
            try? session.setActive(false)
        }
    }

    private func cancelSleep() {
        guard sleepTimer != nil || silence != nil else { return }
        sleepTimer?.invalidate()
        sleepTimer = nil
        silence?.stop()
        silence = nil
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
    }

    // One second of silence as a WAV (16-bit mono, 8 kHz)
    static func silentWav() -> Data {
        let rate: UInt32 = 8000, bytes: UInt32 = rate * 2
        var d = Data()
        func put32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func put16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); put32(36 + bytes); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); put32(16); put16(1); put16(1); put32(rate); put32(rate * 2); put16(2); put16(16)
        d.append("data".data(using: .ascii)!); put32(bytes)
        d.append(Data(count: Int(bytes)))
        return d
    }

    private func finish(_ each: (CAPPluginCall) -> Void) {
        let calls = waiting
        waiting = []
        calls.forEach(each)
    }
}
