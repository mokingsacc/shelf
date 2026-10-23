import Foundation
import UIKit
import Capacitor
import WatchConnectivity
import UserNotifications
import ShelfWatchKit

// The iPhone's end of the link to Shelf on the Apple Watch (the shapes and keys are in ios/ShelfWatchKit; the watch app
// is ios/App/ShelfWatch). The page sends what the watch shows (send, now); the watch's taps come back to the page as
// "command" events, each answered once with reply.
//
// The page isn't always there to answer: Shelf may be closed, or in the background where the iPhone pauses it. So every
// tap is kept in an inbox on disk until the page answers it. If the page doesn't answer within a few seconds, the watch
// hears "open Shelf on your iPhone", and a play waits (15 minutes) behind a "Tap to play" notification: tapping it opens
// Shelf, which reads the inbox and plays it. YouTube only plays videos while Shelf is on screen, so a play the page
// answers with "hidden" gets the same notification.
final class WatchLink: NSObject, WCSessionDelegate, UNUserNotificationCenterDelegate {
    static let shared = WatchLink()

    weak var plugin: ShelfWatchPlugin?
    private let queue = DispatchQueue(label: "shelf.watch")
    private var waiting: [String: DispatchWorkItem] = [:]
    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

    /// Started at launch (a background launch too, so a tap from the watch is never lost)
    func start() {
        guard let s = session else { return }
        if s.delegate !== self { s.delegate = self }
        if s.activationState != .activated { s.activate() }
        if UNUserNotificationCenter.current().delegate == nil { UNUserNotificationCenter.current().delegate = self }
    }

    var status: [String: Any] {
        guard let s = session else { return ["supported": false, "activated": false, "paired": false, "installed": false, "reachable": false] }
        let on = s.activationState == .activated
        return ["supported": true, "activated": on, "paired": on && s.isPaired, "installed": on && s.isWatchAppInstalled, "reachable": on && s.isReachable]
    }

    private var ready: Bool {
        guard let s = session, s.activationState == .activated else { return false }
        return s.isPaired && s.isWatchAppInstalled
    }

    // MARK: Page → watch

    /// What the watch shows, kept on disk too so the watch's hello is answered even before the page has loaded
    func send(snapshot json: String) {
        let data = Data(json.utf8)
        try? data.write(to: Self.file("watch-snapshot.json"), options: .atomic)
        push(data)
    }

    private func push(_ json: Data?) {
        guard ready, let s = session, let json else { return }
        try? s.updateApplicationContext([LinkKey.snapshot: LinkData.pack(json), LinkKey.sentAt: Date().timeIntervalSince1970])
    }

    private func lastSnapshot() -> Data? { try? Data(contentsOf: Self.file("watch-snapshot.json")) }

    /// What plays now, while the watch app is open
    func now(_ json: String) {
        guard let s = session, s.activationState == .activated, s.isReachable else { return }
        s.sendMessage([LinkKey.now: Data(json.utf8)], replyHandler: nil, errorHandler: nil)
    }

    /// The page's answer to one tap
    func reply(id: String, json: String) {
        let data = Data(json.utf8)
        let r = Reply.decode(data)
        queue.async {
            self.waiting.removeValue(forKey: id)?.cancel()
            guard let item = self.item(id) else { self.answer(id, data); return }
            if r?.why == "hidden" {
                // Shelf is in the background: the play waits for a tap on the notification
                self.notify(item)
            } else {
                self.remove(id)
                Self.clearNotification(id)
            }
            self.answer(id, data)
        }
    }

    private func answer(_ id: String, _ data: Data) {
        guard let s = session, s.activationState == .activated, s.isReachable else { return }
        s.sendMessage([LinkKey.result: data, LinkKey.id: id], replyHandler: nil, errorHandler: nil)
    }

    // MARK: Watch → inbox → page

    struct Item: Codable { var id: String; var json: String; var got: Double; var notified: Bool? }

    /// The taps the page hasn't answered yet (each a { id, json }), oldest first
    func inbox() -> [[String: String]] {
        queue.sync {
            prune()
            return readInbox().map { ["id": $0.id, "json": $0.json] }
        }
    }

    private func receive(id: String, json: Data) {
        let name = Command.name(of: json)
        queue.async {
            var list = self.readInbox()
            guard !list.contains(where: { $0.id == id }) else { return }
            list.append(Item(id: id, json: String(decoding: json, as: UTF8.self), got: Date().timeIntervalSince1970, notified: nil))
            self.writeInbox(Array(list.suffix(200)))
            DispatchQueue.main.async { self.plugin?.command(id: id, json: String(decoding: json, as: UTF8.self)) }
            // No answer from the page in time: tell the watch plainly, and keep what should wait
            let work = DispatchWorkItem { [weak self] in self?.noAnswer(id: id, name: name) }
            self.waiting[id] = work
            self.queue.asyncAfter(deadline: .now() + max(2.5, Command.patience(name) - 1.5), execute: work)
        }
    }

    private func noAnswer(id: String, name: String) {
        waiting.removeValue(forKey: id)
        guard let item = item(id) else { return }
        let keep = name == "play" || Command.durable(name)
        if name == "play" { notify(item) }
        if !keep { remove(id) }
        let r: [String: Any] = ["ok": false, "why": "asleep", "queued": keep]
        if let d = try? JSONSerialization.data(withJSONObject: r) { answer(id, d) }
    }

    private func item(_ id: String) -> Item? { readInbox().first { $0.id == id } }

    private func remove(_ id: String) { writeInbox(readInbox().filter { $0.id != id }) }

    /// Taps too old to act on (the page drops them too)
    private func prune() {
        let now = Date()
        let list = readInbox()
        let left = list.filter { it in
            let data = Data(it.json.utf8)
            let made = Command.at(of: data) ?? Date(timeIntervalSince1970: it.got)
            return now.timeIntervalSince(made) < Command.life(Command.name(of: data)) + 60
        }
        if left.count != list.count {
            for gone in list where !left.contains(where: { $0.id == gone.id }) { Self.clearNotification(gone.id) }
            writeInbox(left)
        }
    }

    private func readInbox() -> [Item] {
        guard let d = try? Data(contentsOf: Self.file("watch-inbox.json")), let a = try? JSONDecoder().decode([Item].self, from: d) else { return [] }
        return a
    }

    private func writeInbox(_ list: [Item]) {
        if let d = try? JSONEncoder().encode(list) { try? d.write(to: Self.file("watch-inbox.json"), options: .atomic) }
    }

    private static func file(_ name: String) -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name)
    }

    // MARK: "Tap to play" on the iPhone

    private func notify(_ item: Item) {
        var list = readInbox()
        if let i = list.firstIndex(where: { $0.id == item.id }) { list[i].notified = true; writeInbox(list) }
        let title = Command.title(of: Data(item.json.utf8))
        let c = UNMutableNotificationContent()
        c.title = "Tap to play"
        c.body = (title.isEmpty ? "What you chose on your watch" : "“" + title + "”") + " plays in Shelf when it opens."
        c.sound = nil
        c.threadIdentifier = "shelf-watch"
        if #available(iOS 15.0, *) { c.interruptionLevel = .timeSensitive }
        let req = UNNotificationRequest(identifier: "watch-" + item.id, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req, withCompletionHandler: nil)
    }

    static func clearNotification(_ id: String) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["watch-" + id])
    }

    /// Asked once, while Shelf is on screen and a watch has Shelf on it
    func askToNotify() {
        guard ready else { return }
        UNUserNotificationCenter.current().getNotificationSettings { st in
            guard st.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    var notificationsAllowed: Bool {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        UNUserNotificationCenter.current().getNotificationSettings { st in ok = st.authorizationStatus == .authorized || st.authorizationStatus == .provisional; sem.signal() }
        _ = sem.wait(timeout: .now() + 1)
        return ok
    }

    // Shelf is on screen: the page plays it already, so the banner isn't needed
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(notification.request.identifier.hasPrefix("watch-") ? [] : [.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        // Opening Shelf is the whole job: the page reads the inbox as it comes on screen
        completionHandler()
    }

    // MARK: WCSessionDelegate (on a background queue)

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        push(lastSnapshot())
        reach()
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) { session.activate() }  // another watch was paired

    func sessionWatchStateDidChange(_ session: WCSession) { push(lastSnapshot()); reach() }

    func sessionReachabilityDidChange(_ session: WCSession) { reach() }

    private func reach() {
        let st = status
        DispatchQueue.main.async { self.plugin?.reach(st) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let id = message[LinkKey.id] as? String, let cmd = message[LinkKey.command] as? Data else { replyHandler([:]); return }
        if Command.name(of: cmd) == "hello" {
            // The watch app opened: the latest snapshot at once, from disk
            var r: [String: Any] = [LinkKey.ack: id, "page": plugin != nil]
            if let d = lastSnapshot() { r[LinkKey.snapshot] = LinkData.pack(d) }
            replyHandler(r)
            return
        }
        replyHandler([LinkKey.ack: id, "page": plugin != nil])
        receive(id: id, json: cmd)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let id = message[LinkKey.id] as? String, let cmd = message[LinkKey.command] as? Data else { return }
        receive(id: id, json: cmd)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let id = userInfo[LinkKey.id] as? String, let cmd = userInfo[LinkKey.command] as? Data else { return }
        receive(id: id, json: cmd)
    }
}

/// The page's side, as the Capacitor plugin "ShelfWatch" (registered through packageClassList in capacitor.config.json)
@objc(ShelfWatchPlugin)
public class ShelfWatchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShelfWatchPlugin"
    public let jsName = "ShelfWatch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inbox", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        WatchLink.shared.plugin = self
        WatchLink.shared.start()
        NotificationCenter.default.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
        if UIApplication.shared.applicationState == .active { active() }
    }

    @objc private func active() { WatchLink.shared.askToNotify() }

    @objc func status(_ call: CAPPluginCall) {
        var st = WatchLink.shared.status
        st["notifications"] = WatchLink.shared.notificationsAllowed
        call.resolve(st)
    }

    @objc func send(_ call: CAPPluginCall) {
        WatchLink.shared.send(snapshot: call.getString("json") ?? "{}")
        call.resolve()
    }

    @objc func now(_ call: CAPPluginCall) {
        WatchLink.shared.now(call.getString("json") ?? "{}")
        call.resolve()
    }

    @objc func reply(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("No id"); return }
        WatchLink.shared.reply(id: id, json: call.getString("json") ?? "{}")
        call.resolve()
    }

    @objc func inbox(_ call: CAPPluginCall) {
        call.resolve(["items": WatchLink.shared.inbox()])
    }

    func command(id: String, json: String) { notifyListeners("command", data: ["id": id, "json": json]) }

    func reach(_ st: [String: Any]) { notifyListeners("reach", data: st) }
}
