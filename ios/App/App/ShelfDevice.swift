import UIKit
import CoreLocation
import Capacitor

// The phone things a web page can't do, for the page as the Capacitor plugin "ShelfDevice" (registered through
// packageClassList in capacitor.config.json; dev/vendor-ios.mjs keeps it there):
// - keepAwake: the screen doesn't auto-lock while a video plays in Shelf (YouTube pauses its player when it does)
// - dim: Sleep dim, the screen at its lowest while a video's sleep timer runs; the brightness comes back after
// - statusBar: the clock and battery in dark or light, to match Shelf's day or night look
// - locate: where the phone is, once, for sunrise and sunset (asks the first time)
@objc(ShelfDevicePlugin)
public class ShelfDevicePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "ShelfDevicePlugin"
    public let jsName = "ShelfDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dim", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "statusBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locate", returnType: CAPPluginReturnPromise)
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

    private func finish(_ each: (CAPPluginCall) -> Void) {
        let calls = waiting
        waiting = []
        calls.forEach(each)
    }
}
