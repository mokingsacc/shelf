import UIKit
import WebKit
import Capacitor

// "Sign in to YouTube" for the self-check. Opens Google's sign-in page in a sheet whose web view shares
// Shelf's cookie jar (the default WKWebsiteDataStore), so the YouTube player on the Shelf page sees the same
// account and YouTube Premium applies. The page calls this as the Capacitor plugin "ShelfSignIn"; it is
// registered through packageClassList in capacitor.config.json (dev/vendor-ios.mjs keeps it there).
@objc(ShelfSignInPlugin)
public class ShelfSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShelfSignInPlugin"
    public let jsName = "ShelfSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    // YouTube's own "Sign in" link: Google's page for the YouTube service, landing on YouTube's home page when done
    static let signInURL = URL(string: "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&hl=en&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252F")!
    // Google refuses to sign in from a web view that doesn't present itself as a browser
    static let safariUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    // Any of these on youtube.com means a signed-in account
    static let loginCookies: Set<String> = ["LOGIN_INFO", "SID", "__Secure-1PSID", "__Secure-3PSID", "SAPISID"]

    static func isSignedIn(_ done: @escaping (Bool) -> Void) {
        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                done(cookies.contains { $0.domain.hasSuffix("youtube.com") && ShelfSignInPlugin.loginCookies.contains($0.name) })
            }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        ShelfSignInPlugin.isSignedIn { call.resolve(["signedIn": $0]) }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { return call.reject("Shelf's screen isn't ready") }
            let sheet = SignInSheet(processPool: self.bridge?.webView?.configuration.processPool) { signedIn in
                call.resolve(["signedIn": signedIn])
            }
            host.present(UINavigationController(rootViewController: sheet), animated: true)
        }
    }

    // Forget the YouTube and Google cookies (wrong account, or a sign-in that went sideways)
    @objc func signOut(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let store = WKWebsiteDataStore.default().httpCookieStore
            store.getAllCookies { cookies in
                let mine = cookies.filter { $0.domain.hasSuffix("youtube.com") || $0.domain.hasSuffix("google.com") }
                let group = DispatchGroup()
                for cookie in mine {
                    group.enter()
                    store.delete(cookie) { group.leave() }
                    HTTPCookieStorage.shared.deleteCookie(cookie) // the copy Capacitor keeps for native requests
                }
                group.notify(queue: .main) { call.resolve(["signedIn": false]) }
            }
        }
    }

    // Settings > Shelf, where "Allow Cross-Website Tracking" lives (NSCrossWebsiteTrackingUsageDescription in Info.plist)
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return call.reject("No Settings link") }
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok { call.resolve() } else { call.reject("Couldn't open Settings") }
            }
        }
    }
}

// The sheet: Google's sign-in page with a Done button. Closes itself once it reaches YouTube's home page signed in.
final class SignInSheet: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let web: WKWebView
    private var finish: ((Bool) -> Void)?

    init(processPool: WKProcessPool?, finish: @escaping (Bool) -> Void) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        if let pool = processPool { config.processPool = pool }
        web = WKWebView(frame: .zero, configuration: config)
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
        web.customUserAgent = ShelfSignInPlugin.safariUserAgent
        web.navigationDelegate = self
        web.uiDelegate = self
        title = "Sign in to YouTube"
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped))
        isModalInPresentation = true // only Done closes it, so Shelf always hears the result
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        web.load(URLRequest(url: ShelfSignInPlugin.signInURL))
    }

    @objc private func doneTapped() {
        ShelfSignInPlugin.isSignedIn { self.close(signedIn: $0) }
    }

    private func close(signedIn: Bool) {
        guard let finish = finish else { return }
        self.finish = nil
        finish(signedIn)
        dismiss(animated: true)
    }

    // Landed on YouTube's home page (www or m): signed in means we're done
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, let host = url.host, host.hasSuffix("youtube.com"), url.path == "/" || url.path.isEmpty else { return }
        ShelfSignInPlugin.isSignedIn { if $0 { self.close(signedIn: true) } }
    }

    // Links that want a new window ("Learn more", help pages) open in this same sheet
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}
