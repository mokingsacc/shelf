import Foundation
import SwiftUI
import ShelfWatchKit

/// Where the watch can go on top of the five pages (design.md §2)
enum Route: Hashable {
    case section(String)
    case channel(Channel, section: String)
    case playOn(Entry, band: String)
    case now
    case speed
    case sleep
    case more
    case notes(String)
    case allCourses
    case course(String)
    case check
}

/// Everything the watch knows: the iPhone's latest snapshot, what plays there now, and the answers to taps.
@MainActor
final class Store: ObservableObject {
    static let shared = Store()

    @Published private(set) var snap: Snapshot?
    @Published private(set) var phoneNow: NowState?
    @Published private(set) var reachable = false       // settled: the link down only a moment still counts as in reach
    @Published private(set) var linkTrouble: String?    // the last message the link lost, with its time ("7:41 am · WCErrorDomain 7007")
    @Published private(set) var page = true            // Shelf's page answered the last tap (false: open Shelf on the iPhone)
    @Published private(set) var heardAt: Date?          // the last snapshot or message from the iPhone
    @Published private(set) var waiting = 0             // ticks and spots queued for the iPhone
    @Published var path: [Route] = []
    @Published var tab = 0
    @Published private(set) var checkedAt = Date()
    @Published private(set) var phoneVol: Double?      // the iPhone's volume (0–1), as it last said
    private var phoneVolAt = Date.distantPast
    /// The iPhone's level, if it said it in the last 10 s (a turn starts from nothing older)
    var freshPhoneVol: Double? { Date().timeIntervalSince(phoneVolAt) < 10 ? phoneVol : nil }

    let demo: Bool
    private var pending: [String: CheckedContinuation<Reply, Never>] = [:]
    private var volBusy = false                         // one volume message on its way at a time
    private var volWant: Double?                        // the newest level the Crown asked for, sent when the last one lands
    private var volSent = 0                             // each volume message's number, so a lost one's watchdog can let the next go
    private var linkDownSince: Date?                    // when the link went down (nil while it's up)
    private var reachCheck: Task<Void, Never>?          // the one check that runs while the link is down

    private init() {
        let args = ProcessInfo.processInfo.arguments
        demo = args.contains("-demo")
        if demo { phoneVol = 0.6; phoneVolAt = .distantFuture }
        if demo { loadDemo(args) } else if let d = try? Data(contentsOf: Self.file), let s = Snapshot.decode(d) { snap = s; phoneNow = s.now }
    }

    func start() {
        guard !demo else { return }
        PhoneLink.shared.start()
        hello(woke: true)
    }

    /// Ask the iPhone for the latest at once (the app opened or came back: woke)
    func hello(woke: Bool = false) {
        guard !demo else { return }
        if woke {
            // The link often takes a moment to come up after the app wakes: in reach for now, out of reach only if it stays down
            linkDownSince = nil
            if !PhoneLink.shared.reachable { reachable = true }
        }
        settleReach()
        waiting = PhoneLink.shared.waiting
        checkedAt = Date()
        if let d = PhoneLink.shared.latest(), let s = Snapshot.decode(d) { receive(s) }
        _ = PhoneLink.shared.send(Command("hello"), ack: { page in Task { @MainActor in Store.shared.page = page; Store.shared.heardAt = Date() } }, failed: { _ in })
    }

    /// What the screens show for reach: in reach while the link is up, out of reach once it has been down for reachGrace.
    /// While it's down one check runs every half second (asking the link to start), until it's up or 30 s have gone
    private func settleReach() {
        guard !demo else { return }
        if PhoneLink.shared.reachable {
            linkDownSince = nil
            if !reachable { reachable = true }
            return
        }
        let since = linkDownSince ?? Date()
        linkDownSince = since
        if reachable && Date().timeIntervalSince(since) >= Command.reachGrace { reachable = false }
        guard reachCheck == nil else { return }
        reachCheck = Task { @MainActor in
            while true {
                try? await Task.sleep(nanoseconds: 500_000_000)
                PhoneLink.shared.start()
                let s = Store.shared
                s.settleReach()
                guard let down = s.linkDownSince, Date().timeIntervalSince(down) < 30 else { break }
            }
            Store.shared.reachCheck = nil
        }
    }

    // MARK: From the iPhone

    func receive(_ s: Snapshot) {
        guard snap.map({ s.at >= $0.at }) ?? true else { return }
        snap = s
        heardAt = Date()
        if let n = s.now { if n.at >= (phoneNow?.at ?? 0) { phoneNow = n } } else if s.at >= (phoneNow?.at ?? 0) { phoneNow = nil }
        if let d = try? JSONEncoder().encode(s) { try? d.write(to: Self.file, options: .atomic) }
    }

    func receive(now m: NowMessage) {
        heardAt = Date()
        page = true
        if let n = m.now { if n.at >= (phoneNow?.at ?? 0) { phoneNow = n } } else if m.at >= (phoneNow?.at ?? 0) { phoneNow = nil }
    }

    func linkChanged(reachable r: Bool) {
        settleReach()
        waiting = PhoneLink.shared.waiting
        if r { hello() }
    }

    func queueChanged() { waiting = PhoneLink.shared.waiting }

    /// The iPhone's answer to a tap (from the link)
    func answer(id: String, _ r: Reply) {
        heardAt = Date()
        page = r.why != "asleep" && r.why != "notified" && r.why != "waits"
        if r.hasNow {
            if let n = r.now { if n.at >= (phoneNow?.at ?? 0) { phoneNow = n } } else { phoneNow = nil }
        }
        finish(id, r)
    }

    /// Settles a tap once (the answer, a timeout or a send failure, whichever comes first)
    private func finish(_ id: String, _ r: Reply) { pending.removeValue(forKey: id)?.resume(returning: r) }

    // MARK: To the iPhone

    /// The Crown turned while the iPhone plays: its volume goes there, newest level wins (no queue of old ones)
    func setPhoneVolume(_ v: Double) {
        volWant = min(1, max(0, v))
        if demo { phoneVol = volWant; phoneVolAt = Date(); volWant = nil; return }
        pumpVolume()
    }

    /// What the iPhone's volume is now (its buttons may have changed it)
    func readPhoneVolume() {
        guard !demo, !volBusy else { return }
        sendVolume(nil)
    }

    private func pumpVolume() {
        guard !volBusy, let v = volWant else { return }
        volWant = nil
        sendVolume(v)
    }

    private func sendVolume(_ v: Double?) {
        volBusy = true
        volSent += 1
        let n = volSent
        PhoneLink.shared.volume(v) { r in Task { @MainActor in Store.shared.volLanded(r, n) } }
        // A reply that never comes (the watch app suspended mid-message) doesn't hold the Crown up for long
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if Store.shared.volBusy && Store.shared.volSent == n { Store.shared.volLanded(nil, n) }
        }
    }

    private func volLanded(_ r: Double?, _ n: Int) {
        guard n == volSent, volBusy else { return }
        volBusy = false
        if let r, volWant == nil { phoneVol = r; phoneVolAt = Date() }
        pumpVolume()
    }

    /// One tap, answered once: the page's answer, or a plain reason (out of reach, Shelf closed, no answer)
    func send(_ name: String, _ fields: [String: Any] = [:]) async -> Reply {
        if demo { return Demo.reply(name, fields, store: self) }
        let c = Command(name, fields)
        // The link often takes a moment to come up (the app just woke): the tap waits for it a little, then goes whatever the state
        if !PhoneLink.shared.reachable {
            // (only a second when the screens already say it's out of reach)
            let end = Date().addingTimeInterval(reachable ? Command.reachGrace : 1)
            while !PhoneLink.shared.reachable && Date() < end {
                PhoneLink.shared.start()
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        let r: Reply = await withCheckedContinuation { (k: CheckedContinuation<Reply, Never>) in
            pending[c.id] = k
            switch transmit(c, again: false) {
            case .sent:
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(Command.patience(name) * 1e9))
                    Store.shared.finish(c.id, Reply(ok: false, why: "timeout"))
                }
            case .queued:
                Task { @MainActor in Store.shared.finish(c.id, Reply(ok: false, why: "unreachable", queued: true)) }
            case .failed:
                Task { @MainActor in Store.shared.finish(c.id, Reply(ok: false, why: "unreachable")) }
            }
        }
        waiting = PhoneLink.shared.waiting
        if r.why == "unreachable" { settleReach() }
        return r
    }

    /// Hands one tap to the link (again: the second try of a message that seemed lost, never queued twice)
    private func transmit(_ c: Command, again: Bool) -> PhoneLink.Sent {
        PhoneLink.shared.send(c, queue: !again, ack: { page in
            Task { @MainActor in Store.shared.heardAt = Date(); if !page { Store.shared.page = false } }
        }, failed: { why in
            Task { @MainActor in Store.shared.lost(c, why, again: again) }
        })
    }

    /// A tap's message failed, often only its reply timing out while iOS woke Shelf: once more after a moment if the link is
    /// up (the same id, so the iPhone acts on it once; the tap's patience runs on from the first send), else "unreachable"
    private func lost(_ c: Command, _ why: String, again: Bool) {
        linkTrouble = Self.clock(Date()) + " · " + why
        guard !again, pending[c.id] != nil else { finish(c.id, Reply(ok: false, why: "unreachable", queued: c.durable)); return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 800_000_000)
            let s = Store.shared
            // A failed message often leaves the link down for a moment: it gets 3 s to come back
            var waits = 0
            while !PhoneLink.shared.reachable && waits < 12 && s.pending[c.id] != nil {
                PhoneLink.shared.start()
                try? await Task.sleep(nanoseconds: 250_000_000)
                waits += 1
            }
            guard s.pending[c.id] != nil else { return }
            if !PhoneLink.shared.reachable || s.transmit(c, again: true) != .sent {
                s.finish(c.id, Reply(ok: false, why: "unreachable", queued: c.durable))
            }
        }
    }

    /// A podcast spot from the watch's own playback: queued, so it reaches the iPhone even later
    func sendSpot(_ s: Spot) {
        guard !demo else { return }
        let c = s.command
        if PhoneLink.shared.reachable {
            _ = PhoneLink.shared.send(c, ack: { _ in }, failed: { _ in })
        } else {
            PhoneLink.shared.queue(c)
        }
        waiting = PhoneLink.shared.waiting
    }

    // MARK: What the screens ask

    /// The iPhone can be controlled now: in reach, Shelf's page answers, and it's on screen (YouTube stops videos in the
    /// background; a podcast carries on there, so it stays controllable)
    var live: Bool { reachable && page && (snap?.visible != false || phoneNow?.kind == "audio") }

    /// In reach, but Shelf can't answer there (closed, or asleep in the background). Play still works from the watch: a podcast
    /// plays on the iPhone by itself, a video starts with one tap on the iPhone's "Tap to play"
    var closed: Bool { reachable && !live }

    var stale: String { live ? "" : (snap.map { "Showing " + Self.clock($0.date) } ?? "") }

    func section(_ id: String) -> ShelfWatchKit.Section? { snap?.sections.first { $0.id == id } }
    func course(_ id: String) -> Course? { snap?.courses.first { $0.id == id } }

    static func clock(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.amSymbol = "am"; f.pmSymbol = "pm"
        return f.string(from: d)
    }

    func go(_ r: Route) { path.append(r) }
    /// Starting anything: Now on top of TODAY, so Back goes to TODAY
    func showNow() { tab = 0; path = [.now] }

    private static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("snapshot.json")
    }

    private func loadDemo(_ args: [String]) {
        guard let url = Bundle.main.url(forResource: "demo", withExtension: "json"), let d = try? Data(contentsOf: url), var s = Snapshot.decode(d) else { return }
        s.at = Date().timeIntervalSince1970 * 1000
        snap = s
        reachable = true
        heardAt = Date()
        if args.contains("-away") { reachable = false; page = false; s.at -= 600_000; snap = s }
        if args.contains("-closed") { page = false }   // in reach, Shelf closed on the iPhone
        if args.contains("-playing"), let e = s.sections.first(where: { $0.id == "med" })?.items.first {
            phoneNow = NowState(kind: "video", key: e.key, title: e.title, tag: e.srcName, t: 252, dur: 724, playing: true, rate: 1.5,
                                next: NextUp(label: "1109", title: "Pediatrics", key: "x"), notes: true, at: Date().timeIntervalSince1970 * 1000)
        }
        if args.contains("-message"), var n = phoneNow { n.message = "YouTube stopped it while Shelf was in the background"; phoneNow = n }
        if args.contains("-ended"), var n = phoneNow { n.ended = true; n.autoNext = true; n.playing = false; n.t = n.dur; n.tag = "Paeds · 92 of 130"; phoneNow = n }
    }

    /// Changes the demo's state (screenshots only)
    func demoSet(now: NowState?) { phoneNow = now }
}
