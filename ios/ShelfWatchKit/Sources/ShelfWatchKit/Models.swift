import Foundation

// The shapes Shelf's page sends to the watch (watchSnap, watchNowState and the command replies in dev/src/app.js).
// Decoding is forgiving: a field the page leaves out, or a newer page adds, never stops the watch from showing the rest.

extension KeyedDecodingContainer {
    func v<T: Decodable>(_ key: Key, _ fallback: T) -> T { ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback }
    func o<T: Decodable>(_ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
    /// Numbers may come as 12 or 12.5 (JSON has one number type)
    func num(_ key: Key) -> Double { if let d: Double = o(key) { return d }; if let i: Int = o(key) { return Double(i) }; return 0 }
}

/// One video or episode, as a row the watch can show and start.
public struct Entry: Codable, Hashable, Identifiable, Sendable {
    public var type: String          // "video" or "audio"
    public var key: String           // the YouTube id, or the episode's guid
    public var title: String
    public var srcName: String       // the channel or podcast
    public var src: String
    public var dur: Double
    public var t: Double             // where you are, in seconds
    public var done: Bool
    public var isNew: Bool
    public var section: String
    public var url: String?          // an episode's sound
    public var image: String?
    public var list: String?         // the playlist it plays in
    public var course: String?       // the course it belongs to
    public var label: String?        // the course episode's number, "1115"
    public var short: String?        // its short title, "Pediatrics"
    public var about: Bool?          // the place is only roughly known (Last in YouTube)

    public var id: String { (course ?? "") + "|" + key }
    public var isVideo: Bool { type == "video" }
    public var isAudio: Bool { type == "audio" }
    public var started: Bool { t > 5 && !done }

    public init(type: String, key: String, title: String, srcName: String = "", src: String = "", dur: Double = 0, t: Double = 0, done: Bool = false,
                isNew: Bool = false, section: String = "", url: String? = nil, image: String? = nil, list: String? = nil, course: String? = nil,
                label: String? = nil, short: String? = nil, about: Bool? = nil) {
        self.type = type; self.key = key; self.title = title; self.srcName = srcName; self.src = src; self.dur = dur; self.t = t; self.done = done
        self.isNew = isNew; self.section = section; self.url = url; self.image = image; self.list = list; self.course = course
        self.label = label; self.short = short; self.about = about
    }

    enum K: String, CodingKey { case type, key, title, srcName, src, dur, t, done, isNew, section, url, image, list, course, label, short, about }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        type = c.v(.type, "video"); key = try c.decode(String.self, forKey: .key); title = c.v(.title, "")
        srcName = c.v(.srcName, ""); src = c.v(.src, ""); dur = c.num(.dur); t = c.num(.t); done = c.v(.done, false)
        isNew = c.v(.isNew, false); section = c.v(.section, ""); url = c.o(.url); image = c.o(.image); list = c.o(.list)
        course = c.o(.course); label = c.o(.label); short = c.o(.short); about = c.o(.about)
        if url?.isEmpty == true { url = nil }
        if image?.isEmpty == true { image = nil }
    }
}

/// A Pick up row: Continue, Bedtime, Up next (a course) or Last in YouTube.
public struct Pick: Codable, Hashable, Identifiable, Sendable {
    public var kind: String
    public var label: String?
    public var entry: Entry
    public var id: String { kind + entry.id }
    public var heading: String {
        switch kind {
        case "bedtime": return "Bedtime"
        case "upnext": return "Up next"
        case "lastyt": return "Last in YouTube"
        default: return "Continue"
        }
    }
    public init(kind: String, label: String? = nil, entry: Entry) { self.kind = kind; self.label = label; self.entry = entry }
}

public struct Channel: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var podcast: Bool
    public var newCount: Int
    enum K: String, CodingKey { case id, name, podcast, newCount }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); name = c.v(.name, ""); podcast = c.v(.podcast, false); newCount = c.v(.newCount, 0)
    }
    public init(id: String, name: String, podcast: Bool = false, newCount: Int = 0) { self.id = id; self.name = name; self.podcast = podcast; self.newCount = newCount }
}

public struct Section: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var newCount: Int
    public var more: Int
    public var items: [Entry]
    public var channels: [Channel]
    enum K: String, CodingKey { case id, name, newCount, more, items, channels }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); name = c.v(.name, ""); newCount = c.v(.newCount, 0); more = c.v(.more, 0)
        items = c.v(.items, []); channels = c.v(.channels, [])
    }
    public init(id: String, name: String, newCount: Int = 0, more: Int = 0, items: [Entry] = [], channels: [Channel] = []) {
        self.id = id; self.name = name; self.newCount = newCount; self.more = more; self.items = items; self.channels = channels
    }
}

public struct Course: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var done: Int
    public var total: Int
    public var state: String        // "go", "done", "empty", "new"…
    public var next: Entry?
    public var notch: Int           // the next episode's place in the course (-1 when all are ticked)
    public var ticks: String        // one character per episode, "1" ticked
    public var touched: Double
    public var section: String
    public func ticked(_ i: Int) -> Bool { i >= 0 && i < ticks.count && ticks[ticks.index(ticks.startIndex, offsetBy: i)] == "1" }
    public var fraction: Double { total > 0 ? min(1, Double(done) / Double(total)) : 0 }
    public var finished: Bool { total > 0 && done >= total }
    enum K: String, CodingKey { case id, name, done, total, state, next, notch, ticks, touched, section }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); name = c.v(.name, ""); done = c.v(.done, 0); total = c.v(.total, 0)
        state = c.v(.state, ""); next = c.o(.next); notch = c.v(.notch, -1); ticks = c.v(.ticks, ""); touched = c.num(.touched); section = c.v(.section, "med")
    }
    public init(id: String, name: String, done: Int, total: Int, state: String = "go", next: Entry? = nil, notch: Int = -1, ticks: String = "", touched: Double = 0, section: String = "med") {
        self.id = id; self.name = name; self.done = done; self.total = total; self.state = state; self.next = next; self.notch = notch; self.ticks = ticks
        self.touched = touched; self.section = section
    }
}

public struct Step2: Codable, Hashable, Sendable {
    public var goal: String
    public var date: String         // the exam day, 2026-12-22
    public var days: Int
    public var past: Bool
    public var today: Int           // episodes ticked today
    public var todayMins: Int
    public var left: Int            // episodes left in all courses
    public var perDay: Double       // episodes a day to finish in time
    public var week: [Int]          // ticks on each of the last 7 days, today last
    enum K: String, CodingKey { case goal, date, days, past, today, todayMins, left, perDay, week }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        goal = c.v(.goal, "Step 2 CK"); date = c.v(.date, ""); days = c.v(.days, 0); past = c.v(.past, false); today = c.v(.today, 0); todayMins = c.v(.todayMins, 0)
        left = c.v(.left, 0); perDay = c.num(.perDay); week = c.v(.week, [])
    }
    public init(goal: String, date: String = "", days: Int, past: Bool = false, today: Int = 0, todayMins: Int = 0, left: Int = 0, perDay: Double = 0, week: [Int] = []) {
        self.goal = goal; self.date = date; self.days = days; self.past = past; self.today = today; self.todayMins = todayMins; self.left = left; self.perDay = perDay; self.week = week
    }
}

public struct SleepState: Codable, Hashable, Sendable {
    public var mode: String          // "min" or "end"
    public var minutes: Int?
    public var endsAt: Double?       // ms since 1970
    public var endsDate: Date? { endsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    public init(mode: String, minutes: Int? = nil, endsAt: Double? = nil) { self.mode = mode; self.minutes = minutes; self.endsAt = endsAt }
}

public struct NextUp: Codable, Hashable, Sendable {
    public var label: String
    public var title: String
    public var key: String
    public var course: String?
    public var list: String?
    enum K: String, CodingKey { case label, title, key, course, list }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        label = c.v(.label, ""); title = c.v(.title, ""); key = c.v(.key, ""); course = c.o(.course); list = c.o(.list)
    }
    public init(label: String, title: String, key: String, course: String? = nil, list: String? = nil) {
        self.label = label; self.title = title; self.key = key; self.course = course; self.list = list
    }
}

/// What plays on the iPhone right now.
public struct NowState: Codable, Hashable, Sendable {
    public var kind: String          // "video" or "audio"
    public var key: String
    public var title: String
    public var tag: String           // the channel, podcast or course
    public var t: Double
    public var dur: Double
    public var playing: Bool
    public var buffering: Bool
    public var ended: Bool           // the video reached its end (the phone shows Next up)
    public var autoNext: Bool
    public var rate: Double
    public var timer: SleepState?
    public var next: NextUp?
    public var notes: Bool
    public var message: String
    public var at: Double            // ms since 1970, when the page read t

    public var isVideo: Bool { kind == "video" }
    /// Where it is now: the page's time plus what has played since it looked
    public func position(at date: Date = Date()) -> Double {
        guard playing, at > 0 else { return t }
        let gone = max(0, date.timeIntervalSince1970 - at / 1000) * (rate > 0 ? rate : 1)
        return dur > 0 ? min(dur, t + gone) : t + gone
    }

    enum K: String, CodingKey { case kind, key, title, tag, t, dur, playing, buffering, ended, autoNext, rate, timer, next, notes, message, at }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        kind = c.v(.kind, "video"); key = c.v(.key, ""); title = c.v(.title, ""); tag = c.v(.tag, ""); t = c.num(.t); dur = c.num(.dur)
        playing = c.v(.playing, false); buffering = c.v(.buffering, false); ended = c.v(.ended, false); autoNext = c.v(.autoNext, true); rate = c.num(.rate); if rate <= 0 { rate = 1 }
        timer = c.o(.timer); next = c.o(.next); notes = c.v(.notes, false); message = c.v(.message, ""); at = c.num(.at)
    }
    public init(kind: String, key: String, title: String, tag: String = "", t: Double = 0, dur: Double = 0, playing: Bool = false, buffering: Bool = false,
                ended: Bool = false, autoNext: Bool = true, rate: Double = 1, timer: SleepState? = nil, next: NextUp? = nil, notes: Bool = false, message: String = "", at: Double = 0) {
        self.kind = kind; self.key = key; self.title = title; self.tag = tag; self.t = t; self.dur = dur; self.playing = playing; self.buffering = buffering
        self.ended = ended; self.autoNext = autoNext; self.rate = rate; self.timer = timer; self.next = next; self.notes = notes; self.message = message; self.at = at
    }
}

public struct Rates: Codable, Hashable, Sendable {
    public var video: [Double]
    public var audio: [Double]
    public static let standard = Rates(video: [1, 1.25, 1.5, 1.75, 2], audio: [1, 1.25, 1.5, 2, 0.8])
    public init(video: [Double], audio: [Double]) { self.video = video; self.audio = audio }
    enum K: String, CodingKey { case video, audio }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        video = c.v(.video, Rates.standard.video); audio = c.v(.audio, Rates.standard.audio)
        if video.isEmpty { video = Rates.standard.video }
        if audio.isEmpty { audio = Rates.standard.audio }
    }
}

/// Everything the watch shows, as the page last saw it.
public struct Snapshot: Codable, Hashable, Sendable {
    public var v: Int
    public var at: Double            // ms since 1970
    public var build: String
    public var night: Bool
    public var visible: Bool         // Shelf was on the iPhone's screen
    public var now: NowState?
    public var pick: [Pick]
    public var sections: [Section]
    public var courses: [Course]
    public var step2: Step2?
    public var rates: Rates
    public var presets: [Int]
    public var autoNext: Bool
    public var ai: Bool

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    enum K: String, CodingKey { case v, at, build, night, visible, now, pick, sections, courses, step2, rates, presets, autoNext, ai }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        v = c.v(.v, 1); at = c.num(.at); build = c.v(.build, ""); night = c.v(.night, true); visible = c.v(.visible, false)
        now = c.o(.now); pick = c.v(.pick, []); sections = c.v(.sections, []); courses = c.v(.courses, []); step2 = c.o(.step2)
        rates = c.v(.rates, Rates.standard); presets = c.v(.presets, [15, 30, 45, 60]); autoNext = c.v(.autoNext, true); ai = c.v(.ai, false)
        if presets.isEmpty { presets = [15, 30, 45, 60] }
    }
    public init(v: Int = 1, at: Double, build: String = "", night: Bool = true, visible: Bool = true, now: NowState? = nil, pick: [Pick] = [],
                sections: [Section] = [], courses: [Course] = [], step2: Step2? = nil, rates: Rates = .standard, presets: [Int] = [15, 30, 45, 60],
                autoNext: Bool = true, ai: Bool = false) {
        self.v = v; self.at = at; self.build = build; self.night = night; self.visible = visible; self.now = now; self.pick = pick; self.sections = sections
        self.courses = courses; self.step2 = step2; self.rates = rates; self.presets = presets; self.autoNext = autoNext; self.ai = ai
    }

    public static func decode(_ data: Data) -> Snapshot? {
        guard let raw = LinkData.unpack(data) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: raw)
    }
}

/// A video's podcast version, for Listen on the watch.
public struct Twin: Codable, Hashable, Sendable {
    public var guid: String
    public var url: String
    public var title: String
    public var podcast: String
    public var image: String
    public var dur: Double
    public var linked: Bool          // the same recording: the video's place carries over
    public var start: Double
    enum K: String, CodingKey { case guid, url, title, podcast, image, dur, linked, start }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        guid = c.v(.guid, ""); url = c.v(.url, ""); title = c.v(.title, ""); podcast = c.v(.podcast, ""); image = c.v(.image, "")
        dur = c.num(.dur); linked = c.v(.linked, false); start = c.num(.start)
    }
    public init(guid: String, url: String, title: String, podcast: String = "", image: String = "", dur: Double = 0, linked: Bool = false, start: Double = 0) {
        self.guid = guid; self.url = url; self.title = title; self.podcast = podcast; self.image = image; self.dur = dur; self.linked = linked; self.start = start
    }
}

public struct NotePoint: Codable, Hashable, Sendable {
    public var t: Double?
    public var text: String
    enum K: String, CodingKey { case t, text }
    public init(from d: Decoder) throws { let c = try d.container(keyedBy: K.self); t = c.o(.t); text = c.v(.text, "") }
    public init(t: Double?, text: String) { self.t = t; self.text = text }
}

public struct Summary: Codable, Hashable, Sendable {
    public var gist: String
    public var points: [NotePoint]
    enum K: String, CodingKey { case gist, points }
    public init(from d: Decoder) throws { let c = try d.container(keyedBy: K.self); gist = c.v(.gist, ""); points = c.v(.points, []) }
    public init(gist: String, points: [NotePoint]) { self.gist = gist; self.points = points }
}

/// The iPhone's answer to one tap on the watch.
public struct Reply: Codable, Sendable {
    public var ok: Bool
    public var why: String?
    public var msg: String?
    public var playing: Bool?
    public var now: NowState?
    public var items: [Entry]?
    public var done: Int?
    public var total: Int?
    public var from: Int?
    public var count: Int?
    public var notch: Int?
    public var twin: Twin?
    public var none: Bool?
    public var offline: Bool?
    public var summary: Summary?
    public var working: Bool?
    public var error: String?
    public var kept: Bool?
    public var queued: Bool?
    public var t: Double?
    public var snap: Snapshot?

    enum K: String, CodingKey { case ok, why, msg, playing, now, items, done, total, from, count, notch, twin, none, offline, summary, working, error, kept, queued, t, snap }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        ok = c.v(.ok, false); why = c.o(.why); msg = c.o(.msg); playing = c.o(.playing); now = c.o(.now); items = c.o(.items)
        done = c.o(.done); total = c.o(.total); from = c.o(.from); count = c.o(.count); notch = c.o(.notch); twin = c.o(.twin); none = c.o(.none); offline = c.o(.offline); summary = c.o(.summary)
        working = c.o(.working); error = c.o(.error); kept = c.o(.kept); queued = c.o(.queued); t = c.o(.t); snap = c.o(.snap)
    }
    public init(ok: Bool, why: String? = nil, queued: Bool? = nil) { self.ok = ok; self.why = why; self.queued = queued }

    public static func decode(_ data: Data) -> Reply? { try? JSONDecoder().decode(Reply.self, from: data) }
    /// What went wrong, in plain words for the watch (nil when it worked)
    public var problem: String? { ok ? nil : Words.why(why ?? "error", msg: msg) }
}

/// The page's "now" message: { now, at }
public struct NowMessage: Codable, Sendable {
    public var now: NowState?
    public var at: Double
    enum K: String, CodingKey { case now, at }
    public init(from d: Decoder) throws { let c = try d.container(keyedBy: K.self); now = c.o(.now); at = c.num(.at) }
    public init(now: NowState?, at: Double) { self.now = now; self.at = at }
    public static func decode(_ data: Data) -> NowMessage? { try? JSONDecoder().decode(NowMessage.self, from: data) }
}
