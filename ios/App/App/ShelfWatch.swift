import Foundation
import UIKit
import Capacitor
import WatchConnectivity
import UserNotifications
import AVFoundation
import MediaPlayer
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
    private var tasks: [String: UIBackgroundTaskIdentifier] = [:]   // main thread only: time to answer while in the background
    private var watching = false
    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

    /// Started at launch (a background launch too, so a tap from the watch is never lost)
    func start() {
        guard let s = session else { return }
        if s.delegate !== self { s.delegate = self }
        if s.activationState != .activated { s.activate() }
        if UNUserNotificationCenter.current().delegate == nil { UNUserNotificationCenter.current().delegate = self }
        if !watching {
            watching = true
            // Shelf on screen: a podcast the iPhone played for the watch goes back to the page
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in PocketPlayer.shared.handOver() }
        }
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
        try? data.write(to: Self.file("watch-snapshot.json"), options: .atomic)   // the page's own, so nothing stale outlives the iPhone's player
        push(withPocket(data))
    }

    /// The page's snapshot again (the iPhone's player stopped: the watch shouldn't keep its "now")
    func repush() { push(lastSnapshot()) }

    /// While the iPhone plays a podcast for the watch, that is what plays now, whatever the page last knew
    private func withPocket(_ data: Data) -> Data {
        guard let p = pocketNow(), let n = p, var o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        o["now"] = n
        return (try? JSONSerialization.data(withJSONObject: o)) ?? data
    }

    /// The newest place for an episode waiting in the inbox (the watch's or the iPhone player's), for where the iPhone starts it
    func newestSpot(_ guid: String) -> Double? {
        queue.sync {
            readInbox().compactMap { it -> (Double, Double)? in
                guard let o = (try? JSONSerialization.jsonObject(with: Data(it.json.utf8))) as? [String: Any], o["cmd"] as? String == "audioSpot",
                      o["guid"] as? String == guid else { return nil }
                if (o["done"] as? Bool) == true { return (PocketPlayer.num(o["updated"]) ?? 0, 0) }
                return (PocketPlayer.num(o["updated"]) ?? 0, PocketPlayer.num(o["t"]) ?? 0)
            }.max { $0.0 < $1.0 }?.1
        }
    }

    /// A play or Next from the watch waiting for Shelf to open, newer than this moment
    func playWaiting(since: Date) -> Bool {
        queue.sync {
            readInbox().contains { Self.waits(Command.name(of: Data($0.json.utf8))) && !$0.id.hasPrefix("pocket-") && $0.got >= since.timeIntervalSince1970 }
        }
    }

    private func push(_ json: Data?) {
        guard ready, let s = session, let json else { return }
        try? s.updateApplicationContext([LinkKey.snapshot: LinkData.pack(json), LinkKey.sentAt: Date().timeIntervalSince1970])
    }

    /// The page's last snapshot. With Shelf closed nothing of its own plays, whatever it last said
    private func lastSnapshot() -> Data? {
        guard let d = try? Data(contentsOf: Self.file("watch-snapshot.json")) else { return nil }
        guard plugin == nil, var o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], var n = o["now"] as? [String: Any],
              (n["playing"] as? Bool) == true else { return d }
        n["playing"] = false
        o["now"] = n
        return (try? JSONSerialization.data(withJSONObject: o)) ?? d
    }

    /// What plays now, while the watch app is open (the page's word gives way while the iPhone plays a podcast for the watch)
    func now(_ json: String, pocket: Bool = false) {
        if !pocket && pocketNow() != nil { return }
        guard let s = session, s.activationState == .activated, s.isReachable else { return }
        s.sendMessage([LinkKey.now: Data(json.utf8)], replyHandler: nil, errorHandler: nil)
    }

    /// The page's answer to one tap
    func reply(id: String, json: String) {
        var data = Data(json.utf8)
        // While the iPhone plays a podcast for the watch, the page's idea of what plays now gives way to it
        if let p = pocketNow(), let n = p, var o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if o["now"] != nil { o["now"] = n }
            if var sn = o["snap"] as? [String: Any] { sn["now"] = n; o["snap"] = sn }
            if let d = try? JSONSerialization.data(withJSONObject: o) { data = d }
        }
        let r = Reply.decode(data)
        queue.async {
            self.waiting.removeValue(forKey: id)?.cancel()
            defer { self.endTask(id) }
            // The iPhone's own notes to the page (a podcast's place, a hand-over): nothing for the watch to hear
            if id.hasPrefix("pocket-") { self.remove(id); return }
            guard let item = self.item(id) else { self.answer(id, data); return }
            if r?.why == "hidden" && Self.waits(Command.name(of: Data(item.json.utf8))) {
                // Shelf is in the background: the play waits for a tap on the notification
                self.notify(item)
                if self.notificationsAllowed, let d = try? JSONSerialization.data(withJSONObject: ["ok": false, "why": "notified", "queued": true]) { data = d }
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

    /// Taps that wait for Shelf to open (behind "Tap to play"), rather than being dropped when the page can't act now
    static func waits(_ name: String) -> Bool { name == "play" || name == "next" }

    private func receive(id: String, json raw: Data) {
        DispatchQueue.main.async {
            // A podcast while Shelf isn't on screen, and the remote while one plays: the iPhone plays it itself
            let app = UIApplication.shared
            let away = app.applicationState != .active
            // Play on something paused, while Shelf can't resume it (closed, or asleep in the background): a play of it from its place
            let json = away && !PocketPlayer.shared.active ? self.asPlay(raw) ?? raw : raw
            let name = Command.name(of: json)
            let text = String(decoding: json, as: UTF8.self)
            let task = app.beginBackgroundTask(withName: "shelf-pocket") { [weak self] in self?.endTask("pocket|" + id) }
            if task != .invalid { self.tasks["pocket|" + id] = task }
            if name != "play" || away, let c = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
               PocketPlayer.shared.take(name, c, answer: { r in
                   if name == "play" && (r["ok"] as? Bool) != true {
                       // The iPhone couldn't start it itself: the usual way (the page, or "Tap to play")
                       self.inboxed(id: id, name: name, text: text)
                   } else {
                       self.queue.async { if let d = try? JSONSerialization.data(withJSONObject: r) { self.answer(id, d) } }
                   }
                   self.endTask("pocket|" + id)
               }) {
                if name == "play", let page = self.plugin {
                    // The page (asleep in the background, perhaps playing) stops its own sound
                    page.command(id: "pocket-pause-" + String(Int(PocketPlayer.ms())), json: "{\"cmd\":\"pause\",\"at\":\(Int(PocketPlayer.ms()))}")
                }
                return
            }
            self.endTask("pocket|" + id)
            self.inboxed(id: id, name: name, text: text)
        }
    }

    /// The watch's play on something paused (it sends the entry with it), as a play of that entry; nil for anything else
    private func asPlay(_ json: Data) -> Data? {
        guard Command.name(of: json) == "resume", var c = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any],
              let e = c["entry"] as? [String: Any], (e["key"] as? String ?? "") != "" else { return nil }
        c["cmd"] = "play"
        c.removeValue(forKey: "key")
        return try? JSONSerialization.data(withJSONObject: c, options: [.sortedKeys])
    }

    /// What the iPhone itself plays for the watch now, from any thread
    private func pocketNow() -> [String: Any]?? {
        let read = { PocketPlayer.shared.active ? .some(PocketPlayer.shared.nowState()) : nil } as () -> [String: Any]??
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    }

    /// The page's iPhone-side notes (from PocketPlayer): kept in the inbox like a tap, and given to the page if it's there
    func keep(_ c: [String: Any], id: String) {
        guard let d = try? JSONSerialization.data(withJSONObject: c) else { return }
        let name = c["cmd"] as? String ?? ""
        let text = String(decoding: d, as: UTF8.self)
        queue.async {
            var list = self.readInbox()
            if name == "audioSpot", let g = Self.guid(d) { list.removeAll { Command.name(of: Data($0.json.utf8)) == "audioSpot" && Self.guid(Data($0.json.utf8)) == g } }
            list.append(Item(id: id, json: text, got: Date().timeIntervalSince1970, notified: nil))
            while list.count > 200 {
                if let i = list.firstIndex(where: { Command.name(of: Data($0.json.utf8)) != "tick" }) { list.remove(at: i) } else { list.removeFirst() }
            }
            self.writeInbox(list)
            DispatchQueue.main.async { self.plugin?.command(id: id, json: text) }
        }
    }

    private func inboxed(id: String, name: String, text: String) {
        let json = Data(text.utf8)
        queue.async {
            var list = self.readInbox()
            guard !list.contains(where: { $0.id == id }) else { return }
            // A podcast spot replaces the older spots of the same episode (the newest wins anyway)
            if name == "audioSpot", let g = Self.guid(json) { list.removeAll { Command.name(of: Data($0.json.utf8)) == "audioSpot" && Self.guid(Data($0.json.utf8)) == g } }
            list.append(Item(id: id, json: text, got: Date().timeIntervalSince1970, notified: nil))
            // Never more than 200 kept: the oldest go first, ticks last
            while list.count > 200 {
                if let i = list.firstIndex(where: { Command.name(of: Data($0.json.utf8)) != "tick" }) { list.remove(at: i) } else { list.removeFirst() }
            }
            self.writeInbox(list)
            DispatchQueue.main.async {
                // Shelf may have been woken in the background just for this: ask iOS for the seconds to answer it
                let app = UIApplication.shared
                let task = app.beginBackgroundTask(withName: "shelf-watch") { [weak self] in self?.endTask(id) }
                if task != .invalid { self.tasks[id] = task }
                let page = self.plugin
                page?.command(id: id, json: text)
                // Shelf isn't on screen, so YouTube can't start: "Tap to play" goes up now, not after the page's wait
                if app.applicationState != .active && Self.waits(name) {
                    self.queue.async {
                        guard let it = self.item(id) else { return }
                        self.notify(it)
                        if self.notificationsAllowed, let d = try? JSONSerialization.data(withJSONObject: ["ok": false, "why": "notified", "queued": true]) { self.answer(id, d) }
                    }
                }
                // No answer from the page in time (or no page at all: Shelf isn't open): tell the watch plainly, and keep what should wait
                self.queue.async {
                    let work = DispatchWorkItem { [weak self] in self?.noAnswer(id: id, name: name) }
                    self.waiting[id] = work
                    self.queue.asyncAfter(deadline: .now() + (page == nil ? 0 : max(2.5, Command.patience(name) - 1.5)), execute: work)
                }
            }
        }
    }

    private static func guid(_ json: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: json) as? [String: Any])?["guid"] as? String
    }

    private func endTask(_ id: String) {
        let end = { if let t = self.tasks.removeValue(forKey: id) { UIApplication.shared.endBackgroundTask(t) } }
        if Thread.isMainThread { end() } else { DispatchQueue.main.async(execute: end) }
    }

    private func noAnswer(id: String, name: String) {
        waiting.removeValue(forKey: id)
        defer { endTask(id) }
        guard let item = item(id) else { return }
        let keep = Self.waits(name) || Command.durable(name)
        if Self.waits(name) { notify(item) }
        if !keep { remove(id) }
        let r: [String: Any] = ["ok": false, "why": Self.waits(name) ? (notificationsAllowed ? "notified" : "waits") : "asleep", "queued": keep]
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
        guard item.notified != true else { return }   // once per tap (it may go up at once and again when the page answers)
        var list = readInbox()
        if let i = list.firstIndex(where: { $0.id == item.id }) { list[i].notified = true; writeInbox(list) }
        let title = Command.title(of: Data(item.json.utf8))
        let c = UNMutableNotificationContent()
        c.title = "Tap to play"
        c.body = (title.isEmpty ? "What you chose on your watch" : "“" + title + "”") + " plays in Shelf when it opens."
        c.sound = .default
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
        guard let s = session, s.activationState == .activated, s.isPaired else { return }
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
            var r: [String: Any] = [LinkKey.ack: id, "page": answers]
            if let d = lastSnapshot() { r[LinkKey.snapshot] = LinkData.pack(d) }
            replyHandler(r)
            DispatchQueue.main.async { if PocketPlayer.shared.active { PocketPlayer.shared.sendNow() } }
            return
        }
        replyHandler([LinkKey.ack: id, "page": answers])
        receive(id: id, json: cmd)
    }

    /// Something on the iPhone answers the watch's taps: Shelf's page, or the iPhone's own player
    private var answers: Bool { plugin != nil || pocketNow() != nil }

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

/// A podcast started from the watch while Shelf's page can't play it (Shelf closed, or asleep in the background, where the
/// iPhone stops a web page starting sound): the iPhone plays it here instead, and the watch's remote works on it. Its
/// place goes to the inbox as an audioSpot, like the watch's own playback. When Shelf comes on screen, the page takes it
/// over from that place (audioSpot, then play), so there is only ever one player and one place. Main thread only.
final class PocketPlayer: NSObject {
    static let shared = PocketPlayer()

    private(set) var player: AVPlayer?
    private var entry: [String: Any] = [:]
    private var guid = "", title = "", podcast = "", url = "", image = ""
    private var dur: Double = 0
    private var rate: Double = 1
    private var armed = false              // playback really started where it should; until then its place isn't kept
    private var startedAt = Date()
    private var timerEnds: Date?
    private var timerEnd = false
    private var timerMin: Int?
    private var lastSpot = Date.distantPast
    private var lastNow = Date.distantPast
    private var clock: Timer?
    private var endObs: Any?
    private var statusObs: NSKeyValueObservation?
    private var remote: [Any] = []

    var active: Bool { player != nil }
    private var playing: Bool { guard let p = player else { return false }; return p.timeControlStatus != .paused }
    private var t: Double { let s = player?.currentTime().seconds ?? 0; return s.isFinite ? max(0, s) : 0 }

    /// The commands it answers itself; false leaves the command to the page
    func take(_ name: String, _ c: [String: Any], answer: @escaping ([String: Any]) -> Void) -> Bool {
        switch name {
        case "play":
            guard let e = c["entry"] as? [String: Any], (e["type"] as? String) == "audio", let u = e["url"] as? String, !u.isEmpty else { return false }
            play(e, from: Self.num(c["from"])) { ok in
                answer(ok ? ["ok": true, "playing": true, "now": self.nowState().map { $0 as Any } ?? NSNull()] : ["ok": false, "why": "stalled"])
            }
            return true
        case "toggle", "pause", "resume", "seek", "seekTo", "rate", "timer", "stop":
            guard active else { return false }
            remoteTap(name, c)
            answer(["ok": true, "now": nowState().map { $0 as Any } ?? NSNull()])
            return true
        case "next", "mark":
            guard active else { return false }
            answer(["ok": false, "why": "nothing"])
            return true
        default:
            return false
        }
    }

    // MARK: Playing

    private func play(_ e: [String: Any], from: Double?, done: @escaping (Bool) -> Void) {
        let key = e["key"] as? String ?? ""
        // Where it starts: the watch's own choice, else where this player is in it, else the newest place waiting for Shelf, else Shelf's
        let start = from ?? (active && guid == key ? t : nil) ?? WatchLink.shared.newestSpot(key) ?? ((e["done"] as? Bool) == true ? 0 : Self.num(e["t"]) ?? 0)
        if active { finish(keepPlace: true, quiet: true) }
        entry = e
        guid = key; title = e["title"] as? String ?? "Episode"; podcast = e["srcName"] as? String ?? ""
        url = e["url"] as? String ?? ""; image = e["image"] as? String ?? ""; dur = Self.num(e["dur"]) ?? 0
        rate = Self.num(e["rate"]).flatMap { $0 > 0 ? $0 : nil } ?? 1
        guard let u = URL(string: url) else { done(false); return }
        // In the background the iPhone only lets an app start sound that mixes with others (so the lock screen may not show it;
        // the watch is the remote). On screen it never gets here: the page plays it.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: UIApplication.shared.applicationState == .active ? [] : [.mixWithOthers])
            try session.setActive(true)
        } catch {
            done(false); return
        }
        let item = AVPlayerItem(url: u)
        let p = AVPlayer(playerItem: item)
        p.automaticallyWaitsToMinimizeStalling = true
        player = p
        armed = false
        startedAt = Date()
        timerEnds = nil; timerEnd = false; timerMin = nil
        if Self.late() { setTimer(45) }   // a podcast started at bedtime gets the 45-minute timer, as in Shelf
        endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in self?.ended() }
        // Calls, Siri, alarms and AirPods coming out pause it: the place is kept and the watch hears at once
        statusObs = p.observe(\.timeControlStatus) { [weak self] pl, _ in
            DispatchQueue.main.async {
                guard let self, self.player === pl, self.armed else { return }
                if pl.timeControlStatus == .paused { self.keepSpot() }
                self.nowPlaying(); self.sendNow()
            }
        }
        // Seek once the episode has loaded, then play. The watch waits 8 s, so loading gets 5 s and starting 2 s
        var tries = 0
        func wait() {
            guard player === p else { done(false); return }
            if item.status == .readyToPlay {
                let go = {
                    guard self.player === p else { done(false); return }
                    p.playImmediately(atRate: Float(self.rate))
                    self.confirm(p) { ok in
                        if ok { self.armed = true; self.started() } else { self.finish(keepPlace: false) }
                        done(ok)
                    }
                }
                if start > 1 { p.seek(to: CMTime(seconds: start, preferredTimescale: 600)) { _ in DispatchQueue.main.async(execute: go) } } else { go() }
            } else if item.status == .failed || tries >= 20 {
                finish(keepPlace: false); done(false)
            } else {
                tries += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: wait)
            }
        }
        wait()
    }

    private func confirm(_ p: AVPlayer, tries: Int = 0, _ done: @escaping (Bool) -> Void) {
        guard player === p else { done(false); return }
        if p.timeControlStatus == .playing { done(true); return }
        if tries >= 8 { done(p.timeControlStatus == .waitingToPlayAtSpecifiedRate && p.currentItem?.status != .failed); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.confirm(p, tries: tries + 1, done) }
    }

    private func started() {
        clock?.invalidate()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.second() }
        listenToLockScreen()
        nowPlaying()
        sendNow()
    }

    private func second() {
        guard let p = player, armed else { return }
        if let ends = timerEnds {
            let left = ends.timeIntervalSinceNow
            p.volume = Float(max(0, min(1, left / 60)))   // fades over the last minute
            if left <= 0 { timerEnds = nil; timerMin = nil; pause(); p.volume = 1 }
        }
        if playing && Date().timeIntervalSince(lastSpot) >= 30 { keepSpot() }
        if playing && Date().timeIntervalSince(lastNow) >= 5 { sendNow() }
    }

    private func remoteTap(_ name: String, _ c: [String: Any]) {
        guard let p = player else { return }
        switch name {
        case "toggle": playing ? pause() : resume()
        case "pause": pause()
        case "resume": resume()
        case "seek": seek(to: t + (Self.num(c["by"]) ?? 0))
        case "seekTo": seek(to: Self.num(c["t"]) ?? t)
        case "rate":
            if let r = Self.num(c["r"]), r > 0 { rate = r; if playing { p.rate = Float(r) } }
        case "timer":
            // As on the page: a number or "end" sets it (the same again keeps it); "off" turns it off
            if let m = c["m"] as? String { if m == "end" { timerEnd = true; timerMin = nil; timerEnds = nil } else { timerOff() } }
            else if let m = Self.num(c["m"]), m > 0 { if timerMin != Int(m) { setTimer(Int(m)) } }
            else { timerOff() }
            p.volume = 1
        case "stop": finish(keepPlace: true)
        default: break
        }
        nowPlaying()
        sendNow()
    }

    private func pause() {
        guard let p = player else { return }
        p.pause()
        if !armed { return }       // still starting: it simply won't start
        keepSpot(); nowPlaying(); sendNow()
    }

    private func resume() {
        guard let p = player else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        p.volume = 1
        p.playImmediately(atRate: Float(rate))
        nowPlaying(); sendNow()
    }

    private func seek(to s: Double) {
        guard armed else { return }
        let to = max(0, dur > 0 ? min(dur - 1, s) : s)
        player?.seek(to: CMTime(seconds: to, preferredTimescale: 600)) { _ in DispatchQueue.main.async { self.keepSpot(); self.nowPlaying(); self.sendNow() } }
    }

    private func setTimer(_ m: Int) { timerMin = m; timerEnd = false; timerEnds = Date().addingTimeInterval(Double(m) * 60) }
    private func timerOff() { timerMin = nil; timerEnds = nil; timerEnd = false }

    private func ended() {
        keepSpot(done: true)
        finish(keepPlace: false)
    }

    /// Stops and lets go of everything; with keepPlace, a place that is playing goes to Shelf first (a paused one already did)
    private func finish(keepPlace: Bool, quiet: Bool = false) {
        if keepPlace && playing { keepSpot() }
        statusObs?.invalidate(); statusObs = nil
        player?.pause()
        clock?.invalidate(); clock = nil
        if let endObs { NotificationCenter.default.removeObserver(endObs) }
        endObs = nil
        player = nil
        armed = false
        stopListeningToLockScreen()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if !quiet {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])   // Shelf's own setting again
            sendNow()
            WatchLink.shared.repush()
        }
    }

    /// Shelf came on screen: the page carries on from here (unless the watch has chosen something else that waits for it)
    func handOver() {
        guard active else { return }
        let was = playing && armed
        let at = t
        let since = startedAt
        let r = rate
        finish(keepPlace: true)
        guard was, !WatchLink.shared.playWaiting(since: since) else { return }
        var e = entry
        e["t"] = at; e["done"] = false
        let now = Self.ms()
        WatchLink.shared.keep(["cmd": "play", "entry": e, "at": now], id: "pocket-play-" + String(Int(now)))
        WatchLink.shared.keep(["cmd": "rate", "r": r, "at": now], id: "pocket-rate-" + String(Int(now)))   // a speed set from the watch stays
    }

    // MARK: What Shelf and the watch hear

    private func keepSpot(done: Bool = false) {
        guard !guid.isEmpty, player != nil, armed else { return }
        lastSpot = Date()
        let updated = Self.ms()
        let c: [String: Any] = ["cmd": "audioSpot", "guid": guid, "t": done ? dur : t.rounded(), "dur": dur, "done": done, "updated": updated,
                                "url": url, "title": title, "podcast": podcast, "image": image, "at": updated]
        WatchLink.shared.keep(c, id: "pocket-spot-" + String(Int(updated)))
    }

    func nowState() -> [String: Any]? {
        guard active else { return nil }
        var n: [String: Any] = ["kind": "audio", "key": guid, "title": title, "tag": podcast, "t": (t * 10).rounded() / 10, "dur": dur.rounded(), "playing": playing,
                                "buffering": player?.timeControlStatus == .waitingToPlayAtSpecifiedRate, "rate": rate, "next": NSNull(), "notes": false,
                                "message": "", "url": url, "image": image, "at": Self.ms()]
        if let e = timerEnds, let m = timerMin { n["timer"] = ["mode": "min", "minutes": m, "endsAt": e.timeIntervalSince1970 * 1000] } else if timerEnd { n["timer"] = ["mode": "end"] }
        return n
    }

    func sendNow() {
        lastNow = Date()
        let o: [String: Any] = ["now": nowState().map { $0 as Any } ?? NSNull(), "at": Self.ms()]
        if let d = try? JSONSerialization.data(withJSONObject: o) { WatchLink.shared.now(String(decoding: d, as: UTF8.self), pocket: true) }
    }

    // MARK: The lock screen and Control Centre

    private func nowPlaying() {
        guard active else { return }
        var info: [String: Any] = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: podcast, MPNowPlayingInfoPropertyElapsedPlaybackTime: t,
                                   MPNowPlayingInfoPropertyPlaybackRate: playing ? rate : 0, MPNowPlayingInfoPropertyDefaultPlaybackRate: rate]
        if dur > 0 { info[MPMediaItemPropertyPlaybackDuration] = dur }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func listenToLockScreen() {
        stopListeningToLockScreen()
        let cc = MPRemoteCommandCenter.shared()
        cc.skipBackwardCommand.preferredIntervals = [15]
        cc.skipForwardCommand.preferredIntervals = [30]
        remote = [
            cc.playCommand.addTarget { [weak self] _ in self?.resume(); return .success },
            cc.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success },
            cc.togglePlayPauseCommand.addTarget { [weak self] _ in guard let s = self else { return .commandFailed }; s.playing ? s.pause() : s.resume(); return .success },
            cc.skipBackwardCommand.addTarget { [weak self] _ in guard let s = self else { return .commandFailed }; s.seek(to: s.t - 15); return .success },
            cc.skipForwardCommand.addTarget { [weak self] _ in guard let s = self else { return .commandFailed }; s.seek(to: s.t + 30); return .success },
            cc.changePlaybackPositionCommand.addTarget { [weak self] ev in
                guard let s = self, let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
                s.seek(to: e.positionTime); return .success
            }
        ]
    }

    private func stopListeningToLockScreen() {
        let cc = MPRemoteCommandCenter.shared()
        for r in remote {
            [cc.playCommand, cc.pauseCommand, cc.togglePlayPauseCommand, cc.skipBackwardCommand, cc.skipForwardCommand, cc.changePlaybackPositionCommand].forEach { $0.removeTarget(r) }
        }
        remote = []
    }

    // MARK: Small things

    static func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue ?? (v as? String).flatMap(Double.init) }
    static func ms() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
    static func late(_ d: Date = Date()) -> Bool {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        let m = (c.hour ?? 12) * 60 + (c.minute ?? 0)
        return m >= 21 * 60 + 30 || m < 5 * 60
    }
}
