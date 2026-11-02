import Foundation

/// The iPhone ↔ watch link over WatchConnectivity.
///
/// - iPhone → watch, application context: `snap` (the page's snapshot, packed) and `at`. The watch always has the
///   latest, even if it was asleep when it was sent.
/// - iPhone → watch, message: `now` (what plays now, a NowMessage) while the watch app is open, and `res` + `id`
///   (the answer to one command).
/// - Watch → iPhone, message with a reply: `cmd` + `id`. The iPhone answers at once with `ack` (it has it) and,
///   for `hello`, with `snap` too. The real answer comes later as a `res` message, because the page may need a few
///   seconds (finding a podcast version, starting a video).
/// - Watch → iPhone, user info (queued by the system until the iPhone is reachable): `cmd` + `id`, for what must
///   arrive even if the iPhone is away: ticks and podcast spots from the watch's own playback.
public enum LinkKey {
    public static let snapshot = "snap"
    public static let sentAt = "at"
    public static let now = "now"
    public static let command = "cmd"
    public static let id = "id"
    public static let ack = "ack"
    public static let result = "res"
}

public enum LinkData {
    /// Compresses JSON for the trip; the application context has a size limit.
    public static func pack(_ json: Data) -> Data {
        #if canImport(Darwin)
        return (try? (json as NSData).compressed(using: .zlib) as Data) ?? json
        #else
        return json
        #endif
    }

    /// Reverses `pack`. Plain JSON (starts with `{` or `[`) passes through.
    public static func unpack(_ data: Data) -> Data? {
        if let first = data.first, first == UInt8(ascii: "{") || first == UInt8(ascii: "[") { return data }
        #if canImport(Darwin)
        return try? (data as NSData).decompressed(using: .zlib) as Data
        #else
        return nil
        #endif
    }
}

/// One tap on the watch, as the page reads it: { cmd, at (ms), …fields }.
public struct Command: Sendable {
    public let id: String
    public let name: String
    public let json: Data

    public init(_ name: String, _ fields: [String: Any] = [:], id: String = Command.newID(), at: Date = Date()) {
        var all = fields
        all["cmd"] = name
        all["at"] = (at.timeIntervalSince1970 * 1000).rounded()
        self.id = id
        self.name = name
        self.json = (try? JSONSerialization.data(withJSONObject: all, options: [.sortedKeys])) ?? Data("{\"cmd\":\"\(name)\"}".utf8)
    }

    /// An entry as the page wants it back (the JSON it sent)
    public static func fields(_ e: Entry) -> [String: Any] {
        guard let d = try? JSONEncoder().encode(e), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }

    public static func newID() -> String { "w" + String(UInt64(Date().timeIntervalSince1970 * 1000)) + "-" + String(UInt32.random(in: 0...UInt32.max), radix: 36) }

    /// Taps that must reach the iPhone even if it is away (queued by the system), not only while it's in reach
    public var durable: Bool { Command.durable(name) }
    public static func durable(_ name: String) -> Bool { name == "tick" || name == "audioSpot" }

    /// How long the page still acts on a tap that waited (the page applies the same rule in watchCmd)
    public static func life(_ name: String) -> TimeInterval {
        switch name {
        case "play": return 15 * 60
        case "next": return 5 * 60
        case "tick", "audioSpot": return 7 * 86400
        default: return 10
        }
    }

    /// How long the watch waits for the page's answer before it says the iPhone didn't answer
    public static func patience(_ name: String) -> TimeInterval {
        switch name {
        case "twin": return 16
        case "channel", "section": return 10
        case "play", "next", "resume", "pause", "toggle": return 8
        case "notes": return 6
        default: return 5
        }
    }

    /// The command's name inside its JSON (what the iPhone plugin reads)
    public static func name(of json: Data) -> String {
        (try? JSONSerialization.jsonObject(with: json) as? [String: Any])?["cmd"] as? String ?? ""
    }
    /// The title inside a play command's entry (for the iPhone's "Tap to play" notification)
    public static func title(of json: Data) -> String {
        guard let o = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return "" }
        return (o["entry"] as? [String: Any])?["title"] as? String ?? ""
    }
    /// When the tap was made (ms since 1970 in its JSON)
    public static func at(of json: Data) -> Date? {
        guard let o = try? JSONSerialization.jsonObject(with: json) as? [String: Any], let ms = o["at"] as? Double else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
}

/// A podcast spot from the watch's own playback, newest wins (the page applies the same rule in audioSpot).
public struct Spot: Codable, Hashable, Sendable {
    public var guid: String
    public var t: Double
    public var dur: Double
    public var done: Bool
    public var updated: Double       // ms since 1970
    public var url: String
    public var title: String
    public var podcast: String
    public var image: String
    public var video: String?        // the video this is the podcast version of (its place moves on too)

    public init(guid: String, t: Double, dur: Double, done: Bool = false, updated: Date = Date(), url: String = "", title: String = "",
                podcast: String = "", image: String = "", video: String? = nil) {
        self.guid = guid; self.t = t; self.dur = dur; self.done = done; self.updated = (updated.timeIntervalSince1970 * 1000).rounded()
        self.url = url; self.title = title; self.podcast = podcast; self.image = image; self.video = video
    }

    public func newer(than other: Spot?) -> Bool { other.map { updated > $0.updated } ?? true }

    /// Done when close enough to the end (the page's isDone)
    public static func isDone(_ t: Double, _ dur: Double) -> Bool { dur > 0 && t >= dur - min(20, dur * 0.05) }

    public var command: Command {
        var f: [String: Any] = ["guid": guid, "t": t.rounded(), "dur": dur.rounded(), "done": done, "updated": updated, "url": url, "title": title,
                                "podcast": podcast, "image": image, "source": "watch"]
        if let video { f["video"] = video }
        return Command("audioSpot", f, id: "spot-" + guid.hashValueStable + "-" + String(UInt64(updated)))
    }
}

extension String {
    /// A short stable name for a string (Swift's hashValue changes with every launch)
    public var hashValueStable: String {
        var h: UInt64 = 1469598103934665603
        for b in utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        return String(h, radix: 36)
    }
}
