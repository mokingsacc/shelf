import Foundation

/// What the watch says, in Shelf's words (the page's Core.fmt, Core.left, Core.ago and SleepTimer, in Swift).
public enum Words {
    /// 12:05, or 1:02:03
    public static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.isFinite ? seconds : 0))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%d:%02d", m, r)
    }

    /// "12 min left", "1 hr 5 min left", "Less than a minute left" ("" when the length isn't known)
    public static func left(_ t: Double, _ dur: Double) -> String {
        guard dur > 0 else { return "" }
        let r = max(0, dur - t)
        if r < 60 { return "Less than a minute left" }
        let mins = Int((r / 60).rounded())
        if mins < 60 { return "\(mins) min left" }
        let h = mins / 60, m = mins % 60
        return "\(h) hr" + (m > 0 ? " \(m) min" : "") + " left"
    }

    /// "12 min", "1 hr 5 min"
    public static func length(_ dur: Double) -> String {
        guard dur > 0 else { return "" }
        let mins = max(1, Int((dur / 60).rounded()))
        if mins < 60 { return "\(mins) min" }
        let h = mins / 60, m = mins % 60
        return "\(h) hr" + (m > 0 ? " \(m) min" : "")
    }

    /// "just now", "5 min ago", "today", "yesterday", "3 days ago"
    public static func ago(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let s = now.timeIntervalSince(date)
        if s < 90 { return "just now" }
        if s < 3600 { return "\(Int((s / 60).rounded())) min ago" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return "today" }
        if days == 1 { return "yesterday" }
        if days < 7 { return "\(days) days ago" }
        if days < 14 { return "last week" }
        return "\(days / 7) weeks ago"
    }

    /// The speed as Shelf writes it: 1×, 1.25×, 0.8×
    public static func rate(_ r: Double) -> String {
        let s = r == r.rounded() ? String(Int(r)) : String(format: "%g", r)
        return s + "×"
    }

    /// The sleep timer's readout: "Off", "Ends at the end", "24:10 left"
    public static func sleep(_ t: SleepState?, now: Date = Date()) -> String {
        guard let t else { return "Off" }
        if t.mode == "end" { return "At the end" }
        guard let end = t.endsDate else { return "\(t.minutes ?? 0) min" }
        return countdown(end.timeIntervalSince(now)) + " left"
    }

    /// 4:05, or 1:00:00 (the page's SleepTimer.countdown)
    public static func countdown(_ seconds: Double) -> String {
        let s = Int(max(0, seconds).rounded(.up)), m = s / 60, r = s % 60
        if m >= 60 { return String(format: "%d:%02d:%02d", m / 60, m % 60, r) }
        return String(format: "%d:%02d", m, r)
    }

    /// "60 days to Step 2 CK", "1 day to …", "Step 2 CK is today", "Step 2 CK is done"
    public static func days(_ s: Step2) -> String {
        if s.past { return s.goal + " is done" }
        if s.days <= 0 { return s.goal + " is today" }
        return "\(s.days) day" + (s.days == 1 ? "" : "s") + " to " + s.goal
    }

    /// Why a tap didn't work, said plainly and with what to do
    public static func why(_ code: String, msg: String? = nil) -> String {
        switch code {
        case "hidden": return "Shelf is in the background on your iPhone. Open it there (a play you chose starts then)."
        case "stalled": return "It didn't start on your iPhone. Open Shelf there and try again."
        case "asleep": return "Shelf is closed on your iPhone. Open it there for this."
        case "waits": return "Open Shelf on your iPhone and it starts there."
        case "notified": return "On your iPhone, tap “Tap to play” and it starts."
        case "unreachable": return "Your iPhone isn't in reach. Bring it closer, or play a podcast on the watch."
        case "timeout": return "Your iPhone didn't answer. Open Shelf on it and try again."
        case "old": return "That waited too long, so it was skipped. Tap it again."
        case "nothing": return "Nothing is playing on your iPhone."
        case "end": return "That was the last one."
        case "missing": return "Shelf on your iPhone doesn't have that any more. Pull down there to refresh."
        case "nourl": return "This episode has no sound link yet. Open it once in Shelf on your iPhone."
        case "noai": return "Notes need Gemini switched on in Shelf on your iPhone (Settings › Notes)."
        case "unknown": return "Shelf on your iPhone needs updating for this. Open it once and it updates itself."
        case "nochannel": return "This video's channel isn't in Shelf, so there's no podcast version to find."
        case "nopodcast": return "This channel has no podcast version, so it plays on your iPhone only."
        case "noaudio": return "This podcast couldn't load on the watch. Check the watch has Wi-Fi or your iPhone is near."
        case "noroute": return "Connect AirPods or Bluetooth headphones to the watch to listen here."
        default: return "Something went wrong on your iPhone" + (msg.map { ": " + $0 } ?? ".") + " Try again."
        }
    }
}

/// Small rules both ends agree on.
public enum Rules {
    /// The next speed in the list (Shelf's Speed button cycles the same way)
    public static func nextRate(_ r: Double, in list: [Double]) -> Double {
        guard !list.isEmpty else { return 1 }
        if let i = list.firstIndex(where: { abs($0 - r) < 0.01 }) { return list[(i + 1) % list.count] }
        return list[0]
    }

    /// The volume for a gentle fade over the last minute of a sleep timer (1 before that)
    /// Holding −15 or +15 on the watch: each quarter second moves on by the skip, then 2×, 4× and (past an hour long) 8× it
    public static func holdStep(_ base: Double, held: Double, dur: Double) -> Double {
        let times: Double = held < 2 ? 1 : held < 4 ? 2 : (held < 6 || dur <= 3600) ? 4 : 8
        return base * times
    }

    /// Where a hold's step lands: never before the start, nor past a second before the end (the end would finish it)
    public static func holdMove(_ from: Double, by: Double, dur: Double) -> Double {
        max(0, min(max(0, dur - 1), from + by))
    }

    public static func fadeVolume(endsAt: Date?, now: Date = Date(), fade: TimeInterval = 60) -> Float {
        guard let endsAt else { return 1 }
        return Float(max(0, min(1, endsAt.timeIntervalSince(now) / fade)))
    }

    /// Where to start a podcast: a couple of seconds back for context (the page's resumeAt), the start if it was done
    public static func resumeAt(_ t: Double, dur: Double, done: Bool) -> Double {
        if done || Spot.isDone(t, dur) { return 0 }
        return t > 5 ? max(0, t.rounded(.down) - 3) : 0
    }

    /// How old the watch's copy of the iPhone's state is, said plainly ("" when it is fresh)
    public static func staleness(_ snap: Snapshot?, reachable: Bool, now: Date = Date()) -> String {
        guard let snap else { return "" }
        let age = now.timeIntervalSince(snap.date)
        if reachable && age < 120 { return "" }
        return "As of " + Words.ago(snap.date, now: now)
    }

    /// All a section's rows the watch can start, the new uploads first (as the snapshot orders them)
    public static func playable(_ s: Section) -> [Entry] { s.items.filter { !$0.key.isEmpty } }

    /// Whether this row can play on the watch itself: an episode with a sound link (videos ask for their podcast version)
    public static func watchCanPlay(_ e: Entry) -> Bool { e.isAudio && (e.url?.isEmpty == false) }
}
