import Foundation
import AVFoundation
import MediaPlayer
import ShelfWatchKit

/// What plays on the watch itself: a podcast episode, or a video's podcast version
struct WatchItem: Codable, Equatable {
    var guid: String
    var url: String
    var title: String
    var podcast: String
    var image: String
    var dur: Double
    var video: String?       // the video this is the podcast version of (its place moves on too)
    var videoTitle: String?
}

/// Long-form audio on the watch (AirPods or Bluetooth headphones), with Shelf's sleep timer and speeds. Its spot goes
/// back to the iPhone every 30 s, on pause and at the end, so Shelf there picks up where the watch stopped.
@MainActor
final class WatchPlayer: ObservableObject {
    static let shared = WatchPlayer()

    @Published private(set) var item: WatchItem?
    @Published private(set) var playing = false
    @Published private(set) var loading = false
    @Published private(set) var t: Double = 0
    @Published private(set) var dur: Double = 0
    @Published private(set) var rate: Double = 1
    @Published private(set) var timer: SleepState?
    @Published private(set) var problem: String?       // "noroute", "noaudio", "noairpods"
    @Published private(set) var lastRoute = ""

    private var player: AVPlayer?
    private var tick: Any?
    private var endObs: NSObjectProtocol?
    private var lastSpot = Date.distantPast
    private var timerEnds: Date?
    private let defaults = UserDefaults.standard

    private init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { n in
            let began = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
            if began { Task { @MainActor in WatchPlayer.shared.paused(by: nil) } }
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { n in
            let why = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            // The AirPods went: stop, as the iPhone does, rather than play to no one
            if why == .oldDeviceUnavailable { Task { @MainActor in WatchPlayer.shared.paused(by: "noairpods") } }
            Task { @MainActor in WatchPlayer.shared.readRoute() }
        }
        remote()
        readRoute()
    }

    var active: Bool { item != nil }

    /// Where it is now
    var position: Double { t }

    /// Headphones on this watch (known once a session has been active)
    var headphones: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType != .builtInSpeaker }
    }

    func readRoute() { lastRoute = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portName ?? "" }

    // MARK: Play

    /// Starts an episode from a spot; true when it plays. Asks for AirPods if none are connected (the system's picker).
    func play(_ it: WatchItem, from start: Double) async -> Bool {
        problem = nil
        loading = true
        defer { loading = false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio, options: [])
        } catch {
            problem = "noroute"; return false
        }
        let on: Bool = await withCheckedContinuation { k in
            session.activate(options: []) { ok, _ in k.resume(returning: ok) }
        }
        guard on else { problem = "noroute"; return false }
        readRoute()
        guard let url = URL(string: it.url) else { problem = "noaudio"; return false }

        saveSpot()  // the one before, if another was playing
        stopObserving()
        let pi = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: pi)
        p.automaticallyWaitsToMinimizeStalling = true
        player = p
        item = it
        dur = it.dur
        rate = savedRate(it.podcast)
        t = max(0, start)
        if t > 0 {
            // A seek only works once the episode has loaded (up to 15 s on a slow connection)
            for _ in 0..<60 where pi.status == .unknown { try? await Task.sleep(nanoseconds: 250_000_000) }
            guard player === p else { return false }       // something else was started meanwhile
            guard pi.status == .readyToPlay else { problem = "noaudio"; stop(); return false }
            _ = await p.seek(to: CMTime(seconds: t, preferredTimescale: 600))
        }
        p.defaultRate = Float(rate)
        p.playImmediately(atRate: Float(rate))
        playing = true
        observe(p)
        // Bedtime: a podcast started late gets the 45-minute timer, as on the iPhone
        if timer == nil, Self.late() { setTimer(45) }
        nowPlaying()
        // Did it really start? (no network, a dead link)
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if p.timeControlStatus == .playing { return true }
            if p.currentItem?.status == .failed { break }
        }
        if p.timeControlStatus == .playing || p.timeControlStatus == .waitingToPlayAtSpecifiedRate && p.currentItem?.status != .failed { return true }
        problem = "noaudio"
        stop()
        return false
    }

    static func late(_ d: Date = Date()) -> Bool {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        let m = (c.hour ?? 12) * 60 + (c.minute ?? 0)
        return m >= 21 * 60 + 30 || m < 5 * 60
    }

    func toggle() { playing ? pause() : resume() }

    func pause() { paused(by: nil) }

    private func paused(by why: String?) {
        guard let p = player, playing else { return }
        p.pause()
        playing = false
        if let why { problem = why }
        saveSpot()
        nowPlaying()
    }

    func resume() {
        guard let p = player else { return }
        problem = nil
        let session = AVAudioSession.sharedInstance()
        session.activate(options: []) { ok, _ in
            Task { @MainActor in
                guard ok else { WatchPlayer.shared.problem = "noroute"; return }
                p.playImmediately(atRate: Float(WatchPlayer.shared.rate))
                WatchPlayer.shared.playing = true
                WatchPlayer.shared.nowPlaying()
            }
        }
    }

    func seek(by s: Double) { seek(to: t + s) }

    func seek(to s: Double) {
        guard let p = player else { return }
        let to = max(0, dur > 0 ? min(dur - 1, s) : s)
        t = to
        p.seek(to: CMTime(seconds: to, preferredTimescale: 600))
        nowPlaying()
    }

    func setRate(_ r: Double) {
        rate = r
        if let it = item { defaults.set(r, forKey: "rate." + it.podcast) }
        player?.defaultRate = Float(r)
        if playing { player?.rate = Float(r) }
        nowPlaying()
    }

    private func savedRate(_ podcast: String) -> Double {
        let r = defaults.double(forKey: "rate." + podcast)
        return r > 0 ? r : 1
    }

    /// 15, 30, 45, 60 minutes, "end", or nil for off
    func setTimer(_ m: Int?) {
        if let m, m > 0 {
            timerEnds = Date().addingTimeInterval(Double(m) * 60)
            timer = SleepState(mode: "min", minutes: m, endsAt: timerEnds!.timeIntervalSince1970 * 1000)
        } else {
            timerEnds = nil
            timer = nil
        }
        player?.volume = 1
    }

    func setTimerEnd() { timerEnds = nil; timer = SleepState(mode: "end"); player?.volume = 1 }

    /// Stops and sends the spot; the item stays so Now shows it paused
    func stop() {
        if playing { player?.pause() }
        playing = false
        saveSpot()
        stopObserving()
        player = nil
        item = nil
        timer = nil
        timerEnds = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    // MARK: Time and the sleep timer

    private func observe(_ p: AVPlayer) {
        tick = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 10), queue: .main) { time in
            Task { @MainActor in WatchPlayer.shared.ticked(time.seconds) }
        }
        endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { _ in
            Task { @MainActor in WatchPlayer.shared.ended() }
        }
    }

    private func stopObserving() {
        if let tick, let player { player.removeTimeObserver(tick) }
        tick = nil
        if let endObs { NotificationCenter.default.removeObserver(endObs) }
        endObs = nil
    }

    private func ticked(_ s: Double) {
        guard s.isFinite else { return }
        t = s
        if let d = player?.currentItem?.duration.seconds, d.isFinite, d > 0 { dur = d }
        if let ends = timerEnds {
            player?.volume = Rules.fadeVolume(endsAt: ends)
            if Date() >= ends { paused(by: nil); setTimer(nil); return }
        }
        if playing, Date().timeIntervalSince(lastSpot) >= 30 { saveSpot() }
    }

    private func ended() {
        t = dur
        playing = false
        saveSpot(done: true)
        if timer?.mode == "end" { timer = nil }
        nowPlaying()
    }

    /// The spot, for the iPhone (newest wins there) and for the next start here
    private func saveSpot(done: Bool = false) {
        guard let it = item else { return }
        lastSpot = Date()
        let s = Spot(guid: it.guid, t: t, dur: dur, done: done || Spot.isDone(t, dur), url: it.url, title: it.title, podcast: it.podcast, image: it.image, video: it.video)
        var all = defaults.dictionary(forKey: "spots") as? [String: [Double]] ?? [:]
        all[it.guid] = [s.done ? 0 : t, s.updated]
        if all.count > 200 {
            let keep = all.sorted { ($0.value.last ?? 0) > ($1.value.last ?? 0) }.prefix(150)
            all = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        defaults.set(all, forKey: "spots")
        Store.shared.sendSpot(s)
    }

    /// Where to start an episode: the watch's own spot when it is newer than what the iPhone last sent
    func start(for guid: String, phoneT: Double, phoneAt: Date, dur: Double, done: Bool) -> Double {
        if let s = (defaults.dictionary(forKey: "spots") as? [String: [Double]])?[guid], s.count == 2, s[1] / 1000 > phoneAt.timeIntervalSince1970 {
            return Rules.resumeAt(s[0], dur: dur, done: false)
        }
        return Rules.resumeAt(phoneT, dur: dur, done: done)
    }

    // MARK: Now Playing and the system's controls (the AirPods, the watch's own Now Playing)

    private func nowPlaying() {
        guard let it = item else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: it.title,
            MPMediaItemPropertyArtist: it.podcast,
            MPMediaItemPropertyPlaybackDuration: dur,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: t,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? rate : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: rate
        ]
    }

    private func remote() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { _ in Task { @MainActor in WatchPlayer.shared.resume() }; return .success }
        c.pauseCommand.addTarget { _ in Task { @MainActor in WatchPlayer.shared.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { _ in Task { @MainActor in WatchPlayer.shared.toggle() }; return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { _ in Task { @MainActor in WatchPlayer.shared.seek(by: -15) }; return .success }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { _ in Task { @MainActor in WatchPlayer.shared.seek(by: 30) }; return .success }
        c.changePlaybackPositionCommand.addTarget { e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let to = e.positionTime
            Task { @MainActor in WatchPlayer.shared.seek(to: to) }
            return .success
        }
    }

    // MARK: Screenshots

    func demo(_ it: WatchItem, t: Double, playing: Bool) {
        item = it; dur = it.dur; self.t = t; self.playing = playing; rate = 1
        setTimer(45)
    }
}
