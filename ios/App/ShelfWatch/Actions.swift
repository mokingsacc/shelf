import Foundation
import WatchKit
import ShelfWatchKit

/// The buzzes (design.md §5). Nothing buzzes that Mo didn't cause.
enum Haptic {
    static func start() { WKInterfaceDevice.current().play(.start) }
    static func stop() { WKInterfaceDevice.current().play(.stop) }
    static func select() { WKInterfaceDevice.current().play(.click) }
    static func success() { WKInterfaceDevice.current().play(.success) }
    static func warn() { WKInterfaceDevice.current().play(.retry) }
}

/// What the remote shows: the watch's own playback when there is one, else what plays on the iPhone
struct Showing: Equatable {
    var onWatch: Bool
    var kind: String          // "video" or "audio"
    var key: String
    var title: String
    var tag: String
    var t: Double
    var dur: Double
    var playing: Bool
    var rate: Double
    var timer: SleepState?
    var next: NextUp?
    var notes: Bool
    var ended: Bool
    var autoNext: Bool
    var message: String

    var isVideo: Bool { kind == "video" }
    var skip: Double { isVideo ? 15 : 30 }
}

@MainActor
enum Act {
    static func showing(_ store: Store, _ player: WatchPlayer, at date: Date = Date()) -> Showing? {
        if let it = player.item {
            return Showing(onWatch: true, kind: "audio", key: it.guid, title: it.title, tag: it.podcast, t: player.t, dur: player.dur, playing: player.playing,
                           rate: player.rate, timer: player.timer, next: nil, notes: false, ended: false, autoNext: false,
                           message: player.problem == "noairpods" ? "NO AIRPODS" : "")
        }
        guard let n = store.phoneNow else { return nil }
        // The phone's clock runs on from its last word only while it can be heard; otherwise it stays where it was
        return Showing(onWatch: false, kind: n.kind, key: n.key, title: n.title, tag: n.tag, t: store.live ? n.position(at: date) : n.t, dur: n.dur, playing: n.playing,
                       rate: n.rate, timer: n.timer, next: n.next, notes: n.notes, ended: n.ended, autoNext: n.autoNext, message: n.message)
    }

    /// Plays on the iPhone; nil when it started, else what to say
    static func onPhone(_ e: Entry, from: Double? = nil) async -> String? {
        var f: [String: Any] = ["entry": Command.fields(e)]
        if let from { f["from"] = from }
        let r = await Store.shared.send("play", f)
        if r.ok {
            // One thing plays at a time
            if WatchPlayer.shared.playing { WatchPlayer.shared.pause() }
            if WatchPlayer.shared.active { WatchPlayer.shared.stop() }
            Haptic.start()
            Store.shared.showNow()
            return nil
        }
        Haptic.warn()
        return r.problem
    }

    /// Plays an episode, or a video's podcast version, on the watch; nil when it started, else what to say
    static func onWatch(_ it: WatchItem, from: Double) async -> String? {
        let ok = await WatchPlayer.shared.play(it, from: from)
        guard ok else { Haptic.warn(); return Words.why(WatchPlayer.shared.problem ?? "noaudio") }
        Haptic.start()
        Store.shared.showNow()
        // One thing plays at a time: the iPhone pauses
        if Store.shared.phoneNow?.playing == true { _ = await Store.shared.send("pause") }
        return nil
    }

    static func watchItem(_ e: Entry) -> WatchItem? {
        guard e.isAudio, let url = e.url, !url.isEmpty else { return nil }
        return WatchItem(guid: e.key, url: url, title: e.title, podcast: e.srcName, image: e.image ?? "", dur: e.dur, video: nil, videoTitle: nil)
    }

    static func watchItem(_ tw: Twin, video: Entry?) -> WatchItem {
        WatchItem(guid: tw.guid, url: tw.url, title: tw.title, podcast: tw.podcast, image: tw.image, dur: tw.dur,
                  video: tw.linked ? video?.key : nil, videoTitle: video?.title)
    }

    /// Where an episode starts on the watch
    static func start(_ e: Entry) -> Double {
        WatchPlayer.shared.start(for: e.key, phoneT: e.t, phoneAt: Store.shared.snap?.date ?? .distantPast, dur: e.dur, done: e.done)
    }

    // MARK: The remote: the same taps for the watch's playback and the iPhone's

    static func toggle(_ s: Showing) async {
        if s.onWatch { s.playing ? Haptic.stop() : Haptic.start(); WatchPlayer.shared.toggle(); return }
        let r = await Store.shared.send("toggle")
        if r.ok { (r.now?.playing ?? false) ? Haptic.start() : Haptic.stop() } else { Haptic.warn() }
    }

    static func skip(_ s: Showing, by: Double) async {
        Haptic.select()
        if s.onWatch { WatchPlayer.shared.seek(by: by); return }
        let r = await Store.shared.send("seek", ["by": by])
        if !r.ok { Haptic.warn() }
    }

    static func seek(_ s: Showing, to: Double) async -> Bool {
        if s.onWatch { WatchPlayer.shared.seek(to: to); Haptic.success(); return true }
        let r = await Store.shared.send("seekTo", ["t": to.rounded()])
        r.ok ? Haptic.success() : Haptic.warn()
        return r.ok
    }

    static func rate(_ s: Showing, _ r: Double) async {
        Haptic.select()
        if s.onWatch { WatchPlayer.shared.setRate(r); return }
        let a = await Store.shared.send("rate", ["r": r])
        if !a.ok { Haptic.warn() }
    }

    /// minutes, "end" or "off"
    static func timer(_ s: Showing, _ m: String) async {
        if s.onWatch {
            if m == "off" { WatchPlayer.shared.setTimer(nil) } else if m == "end" { WatchPlayer.shared.setTimerEnd() } else { WatchPlayer.shared.setTimer(Int(m)) }
            Haptic.success(); return
        }
        let v: Any = Int(m).map { $0 as Any } ?? m
        let r = await Store.shared.send("timer", ["m": v])
        r.ok ? Haptic.success() : Haptic.warn()
    }

    static func mark(at t: Double) async -> Bool {
        let r = await Store.shared.send("mark", ["t": t.rounded(.down)])
        r.ok ? Haptic.success() : Haptic.warn()
        return r.ok
    }

    static func next() async -> String? {
        let r = await Store.shared.send("next")
        if r.ok { Haptic.start(); return nil }
        Haptic.warn()
        return r.problem
    }

    static func stop(_ s: Showing) async {
        if s.onWatch { WatchPlayer.shared.stop(); Haptic.stop(); return }
        _ = await Store.shared.send("stop")
        Haptic.stop()
    }

    /// Ticks (or unticks) a course episode; true when the iPhone has it, or it is queued for it
    static func tick(course: String, key: String, on: Bool) async -> (ok: Bool, queued: Bool, problem: String?) {
        let r = await Store.shared.send("tick", ["course": course, "key": key, "on": on])
        if r.ok { Haptic.success(); return (true, false, nil) }
        if r.queued == true { Haptic.success(); return (true, true, nil) }
        Haptic.warn()
        return (false, false, r.problem)
    }

    /// A podcast on the iPhone moves to the watch, from its spot (the iPhone pauses)
    static func moveToWatch(_ s: Showing) async -> String? {
        let n = Store.shared.phoneNow
        let e = Store.shared.snap?.sections.flatMap(\.items).first { $0.key == s.key }
        guard let url = n?.url ?? e?.url, !url.isEmpty else { return Words.why("nourl") }
        let it = WatchItem(guid: s.key, url: url, title: s.title, podcast: s.tag, image: n?.image ?? e?.image ?? "", dur: s.dur, video: nil, videoTitle: nil)
        return await onWatch(it, from: max(0, s.t - 2))
    }

    /// A podcast on the watch moves to the iPhone: its spot first (newest wins there), then play
    static func moveToPhone() async -> String? {
        guard let it = WatchPlayer.shared.item else { return nil }
        let t = WatchPlayer.shared.t, rate = WatchPlayer.shared.rate
        WatchPlayer.shared.stop()
        let e = Entry(type: "audio", key: it.guid, title: it.title, srcName: it.podcast, dur: it.dur, t: t, url: it.url, image: it.image, rate: rate)
        return await onPhone(e)
    }
}
