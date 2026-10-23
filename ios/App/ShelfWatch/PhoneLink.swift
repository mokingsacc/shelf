import Foundation
import WatchConnectivity
import ShelfWatchKit

// The watch's end of the link to Shelf on the iPhone (the keys are in ShelfWatchKit/Link.swift; the iPhone's end is
// ios/App/App/ShelfWatch.swift). What the watch shows arrives as the application context and as "now" messages; each
// tap goes as a message, and its answer comes back as a "res" message with the same id.
final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = PhoneLink()

    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

    func start() {
        guard let s = session else { return }
        if s.delegate !== self { s.delegate = self }
        if s.activationState != .activated { s.activate() }
    }

    var active: Bool { session?.activationState == .activated }
    var reachable: Bool { active && (session?.isReachable ?? false) }
    /// Taps the system still holds for the iPhone (ticks and podcast spots)
    var waiting: Int { active ? (session?.outstandingUserInfoTransfers.count ?? 0) : 0 }

    /// The latest snapshot the iPhone left for the watch
    func latest() -> Data? {
        guard let s = session, s.activationState == .activated, let d = s.receivedApplicationContext[LinkKey.snapshot] as? Data else { return nil }
        return LinkData.unpack(d)
    }

    enum Sent { case sent, queued, failed }

    /// One tap: a message while the iPhone is in reach (its ack says whether Shelf's page is there), else queued if it must arrive
    func send(_ c: Command, ack: @escaping @Sendable (_ page: Bool) -> Void, failed: @escaping @Sendable () -> Void) -> Sent {
        guard let s = session, s.activationState == .activated else { return .failed }
        let msg: [String: Any] = [LinkKey.command: c.json, LinkKey.id: c.id]
        if s.isReachable {
            s.sendMessage(msg, replyHandler: { r in
                if let snap = r[LinkKey.snapshot] as? Data, let d = LinkData.unpack(snap) { Self.deliver(snapshot: d) }
                ack(r["page"] as? Bool ?? true)
            }, errorHandler: { _ in
                if c.durable { s.transferUserInfo(msg) }
                failed()
            })
            return .sent
        }
        if c.durable { s.transferUserInfo(msg); return .queued }
        return .failed
    }

    /// Queued for the iPhone whatever happens (a podcast spot from the watch's own playback)
    func queue(_ c: Command) {
        guard let s = session, s.activationState == .activated else { return }
        s.transferUserInfo([LinkKey.command: c.json, LinkKey.id: c.id])
    }

    private static func deliver(snapshot d: Data) {
        guard let snap = Snapshot.decode(d) else { return }
        Task { @MainActor in Store.shared.receive(snap) }
    }

    // MARK: WCSessionDelegate (on a background queue)

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if let d = latest() { Self.deliver(snapshot: d) }
        let r = session.isReachable
        Task { @MainActor in Store.shared.linkChanged(reachable: r) }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        let r = session.isReachable
        Task { @MainActor in Store.shared.linkChanged(reachable: r) }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let p = applicationContext[LinkKey.snapshot] as? Data, let d = LinkData.unpack(p) { Self.deliver(snapshot: d) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let d = message[LinkKey.now] as? Data, let n = NowMessage.decode(d) {
            Task { @MainActor in Store.shared.receive(now: n) }
        }
        if let id = message[LinkKey.id] as? String, let d = message[LinkKey.result] as? Data {
            let r = Reply.decode(d) ?? Reply(ok: false, why: "error")
            Task { @MainActor in Store.shared.answer(id: id, r) }
        }
    }

    func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: Error?) {
        Task { @MainActor in Store.shared.queueChanged() }
    }
}
