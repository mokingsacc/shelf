import XCTest
@testable import ShelfWatchKit

// The watch reads exactly what Shelf's page sends: these fixtures were recorded from the page (dev/test/e2e.mjs, block W).
final class ShelfWatchKitTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    func testSnapshotFromThePage() throws {
        let snap = try XCTUnwrap(Snapshot.decode(try fixture("snapshot")))
        XCTAssertEqual(snap.v, 1)
        XCTAssertEqual(snap.sections.map(\.name).prefix(3), ["Entertainment", "Medicine", "Sleep"])
        let med = try XCTUnwrap(snap.sections.first { $0.id == "med" })
        XCTAssertGreaterThanOrEqual(med.items.count, 3)
        XCTAssertGreaterThanOrEqual(med.channels.count, 2)
        XCTAssertTrue(med.items.allSatisfy { !$0.key.isEmpty && !$0.title.isEmpty })
        let sleep = try XCTUnwrap(snap.sections.first { $0.id == "sleep" })
        XCTAssertTrue(sleep.items.contains { Rules.watchCanPlay($0) }, "Sleep episodes carry their sound link")
        XCTAssertFalse(snap.courses.isEmpty)
        XCTAssertTrue(snap.courses.allSatisfy { $0.total >= $0.done && !$0.name.isEmpty })
        let go = try XCTUnwrap(snap.courses.first { $0.next != nil })
        XCTAssertEqual(go.ticks.count, go.total)
        XCTAssertEqual((0..<go.total).filter { go.ticked($0) }.count, go.done)
        XCTAssertFalse(go.ticked(go.notch), "the next episode is not ticked")
        XCTAssertFalse(go.ticked(-1)); XCTAssertFalse(go.ticked(go.total))
        XCTAssertEqual(snap.step2?.date.count, 10)
        let s2 = try XCTUnwrap(snap.step2)
        XCTAssertGreaterThan(s2.days, 0)
        XCTAssertEqual(s2.week.count, 7)
        XCTAssertEqual(snap.rates.video, [1, 1.25, 1.5, 1.75, 2])
        XCTAssertEqual(snap.presets, [15, 30, 45, 60])
        XCTAssertFalse(snap.pick.isEmpty)
    }

    func testNowMessagesFromThePage() throws {
        let list = try XCTUnwrap(try JSONSerialization.jsonObject(with: try fixture("nows")) as? [Any])
        let nows = try list.map { try JSONDecoder().decode(NowMessage.self, from: JSONSerialization.data(withJSONObject: $0)) }
        XCTAssertFalse(nows.isEmpty)
        let video = try XCTUnwrap(nows.compactMap(\.now).first { $0.isVideo && $0.playing })
        XCTAssertFalse(video.title.isEmpty)
        XCTAssertGreaterThan(video.dur, 0)
        XCTAssertTrue(nows.compactMap(\.now).contains { $0.kind == "audio" }, "a podcast on the iPhone shows too")
        XCTAssertTrue(nows.compactMap(\.now).contains { $0.timer?.mode == "min" && $0.timer?.endsAt != nil }, "the sleep timer comes with its end")
        XCTAssertTrue(nows.compactMap(\.now).contains { $0.next != nil }, "what plays next comes too")
        XCTAssertTrue(nows.contains { $0.now == nil }, "nothing playing is a message too")
    }

    func testRepliesFromThePage() throws {
        let dict = try XCTUnwrap(try JSONSerialization.jsonObject(with: try fixture("replies")) as? [String: Any])
        var replies: [Reply] = []
        for (_, v) in dict { replies.append(try JSONDecoder().decode(Reply.self, from: JSONSerialization.data(withJSONObject: v))) }
        XCTAssertGreaterThan(replies.count, 10)
        XCTAssertTrue(replies.contains { $0.ok && $0.playing == true && $0.now != nil }, "a play's answer")
        XCTAssertTrue(replies.contains { $0.ok && ($0.items?.count ?? 0) >= 3 }, "a list's answer")
        XCTAssertTrue(replies.contains { $0.ok && $0.total != nil && $0.done != nil }, "a tick's answer")
        XCTAssertTrue(replies.contains { $0.ok && $0.kept == true }, "a spot kept")
        XCTAssertTrue(replies.contains { $0.why == "old" })
        let hidden = try XCTUnwrap(Reply.decode(Data(#"{"ok":false,"why":"hidden","now":null}"#.utf8)))
        XCTAssertEqual(hidden.problem, Words.why("hidden"))
        XCTAssertNil(Reply(ok: true).problem)
        XCTAssertTrue(replies.contains { $0.why == "unknown" })
    }

    func testForgivingDecoding() throws {
        // A page older or newer than the watch: missing fields fall back, extra fields are ignored
        let json = #"{"sections":[{"id":"x","items":[{"key":"abc","extra":1}]}],"now":{"kind":"audio","t":12.5,"playing":true,"rate":0},"future":true}"#
        let snap = try XCTUnwrap(Snapshot.decode(Data(json.utf8)))
        XCTAssertEqual(snap.sections[0].items[0].type, "video")
        XCTAssertEqual(snap.now?.rate, 1)
        XCTAssertEqual(snap.rates, .standard)
        XCTAssertNil(Snapshot.decode(Data("nonsense".utf8)))
    }

    func testPackRoundTrip() throws {
        let raw = try fixture("snapshot")
        let packed = LinkData.pack(raw)
        #if canImport(Darwin)
        XCTAssertLessThan(packed.count, raw.count / 2, "packed for the trip")
        #endif
        XCTAssertEqual(LinkData.unpack(packed), raw)
        XCTAssertEqual(LinkData.unpack(Data("{\"a\":1}".utf8)), Data("{\"a\":1}".utf8))
    }

    func testCommandJSON() throws {
        let e = Entry(type: "video", key: "abc", title: "A video", dur: 600, course: "PL1", label: "1115")
        let c = Command("play", ["entry": Command.fields(e), "from": 30], id: "w1", at: Date(timeIntervalSince1970: 1000))
        let o = try XCTUnwrap(try JSONSerialization.jsonObject(with: c.json) as? [String: Any])
        XCTAssertEqual(o["cmd"] as? String, "play")
        XCTAssertEqual(o["at"] as? Double, 1_000_000)
        XCTAssertEqual((o["entry"] as? [String: Any])?["key"] as? String, "abc")
        XCTAssertEqual((o["entry"] as? [String: Any])?["course"] as? String, "PL1")
        XCTAssertEqual(Command.name(of: c.json), "play")
        XCTAssertEqual(Command.title(of: c.json), "A video")
        XCTAssertEqual(Command.at(of: c.json), Date(timeIntervalSince1970: 1000))
        XCTAssertFalse(c.durable)
        XCTAssertTrue(Command("tick").durable)
        XCTAssertEqual(Command.life("play"), 900)
        XCTAssertEqual(Command.life("toggle"), 60)
        XCTAssertNotEqual(Command.newID(), Command.newID())
    }

    func testSpots() {
        let a = Spot(guid: "g", t: 100, dur: 3600, updated: Date(timeIntervalSince1970: 10))
        let b = Spot(guid: "g", t: 50, dur: 3600, updated: Date(timeIntervalSince1970: 20))
        XCTAssertTrue(b.newer(than: a))
        XCTAssertFalse(a.newer(than: b))
        XCTAssertTrue(a.newer(than: nil))
        XCTAssertEqual(a.command.name, "audioSpot")
        XCTAssertEqual(a.command.id, a.command.id, "the same spot has the same id, so it is filed once")
        XCTAssertTrue(Spot.isDone(3590, 3600))
        XCTAssertFalse(Spot.isDone(3500, 3600))
        XCTAssertEqual("abc".hashValueStable, "abc".hashValueStable)
    }

    func testWords() {
        XCTAssertEqual(Words.clock(65), "1:05")
        XCTAssertEqual(Words.clock(3723), "1:02:03")
        XCTAssertEqual(Words.clock(-4), "0:00")
        XCTAssertEqual(Words.clock(.nan), "0:00")
        XCTAssertEqual(Words.left(0, 30), "Less than a minute left")
        XCTAssertEqual(Words.left(0, 720), "12 min left")
        XCTAssertEqual(Words.left(0, 3900), "1 hr 5 min left")
        XCTAssertEqual(Words.left(0, 0), "")
        XCTAssertEqual(Words.length(3600), "1 hr")
        XCTAssertEqual(Words.rate(1), "1×")
        XCTAssertEqual(Words.rate(1.25), "1.25×")
        XCTAssertEqual(Words.rate(0.8), "0.8×")
        XCTAssertEqual(Words.countdown(59.2), "1:00")
        XCTAssertEqual(Words.countdown(3600), "1:00:00")
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(Words.sleep(SleepState(mode: "min", minutes: 30, endsAt: (now.timeIntervalSince1970 + 600) * 1000), now: now), "10:00 left")
        XCTAssertEqual(Words.sleep(SleepState(mode: "end")), "At the end")
        XCTAssertEqual(Words.sleep(nil), "Off")
        XCTAssertEqual(Words.ago(now.addingTimeInterval(-30), now: now), "just now")
        XCTAssertEqual(Words.ago(now.addingTimeInterval(-600), now: now), "10 min ago")
        XCTAssertEqual(Words.days(Step2(goal: "Step 2 CK", days: 60)), "60 days to Step 2 CK")
        XCTAssertEqual(Words.days(Step2(goal: "Step 2 CK", days: 1)), "1 day to Step 2 CK")
        XCTAssertEqual(Words.days(Step2(goal: "Step 2 CK", days: 0, past: true)), "Step 2 CK is done")
        for code in ["hidden", "stalled", "asleep", "unreachable", "timeout", "old", "nothing", "end", "missing", "nourl", "noai", "unknown", "noroute"] {
            XCTAssertFalse(Words.why(code).contains("went wrong"), code + " has its own words")
        }
        XCTAssertTrue(Words.why("error", msg: "boom").contains("boom"))
    }

    func testRules() {
        XCTAssertEqual(Rules.nextRate(1, in: Rates.standard.video), 1.25)
        XCTAssertEqual(Rules.nextRate(2, in: Rates.standard.video), 1)
        XCTAssertEqual(Rules.nextRate(2, in: Rates.standard.audio), 0.8)
        XCTAssertEqual(Rules.nextRate(3, in: Rates.standard.audio), 1)
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertEqual(Rules.fadeVolume(endsAt: now.addingTimeInterval(30), now: now), 0.5, accuracy: 0.001)
        XCTAssertEqual(Rules.fadeVolume(endsAt: now.addingTimeInterval(600), now: now), 1)
        XCTAssertEqual(Rules.fadeVolume(endsAt: now.addingTimeInterval(-5), now: now), 0)
        XCTAssertEqual(Rules.fadeVolume(endsAt: nil), 1)
        XCTAssertEqual(Rules.resumeAt(100.7, dur: 3600, done: false), 97)
        XCTAssertEqual(Rules.resumeAt(3, dur: 3600, done: false), 0)
        XCTAssertEqual(Rules.resumeAt(3595, dur: 3600, done: false), 0)
        XCTAssertEqual(Rules.resumeAt(100, dur: 3600, done: true), 0)
        let snap = Snapshot(at: (now.timeIntervalSince1970 - 30) * 1000)
        XCTAssertEqual(Rules.staleness(snap, reachable: true, now: now), "")
        XCTAssertEqual(Rules.staleness(snap, reachable: false, now: now), "As of just now")
    }

    func testPositionTicksOn() {
        let n = NowState(kind: "video", key: "a", title: "A", t: 100, dur: 600, playing: true, rate: 1.5, at: 1_000_000)
        XCTAssertEqual(n.position(at: Date(timeIntervalSince1970: 1010)), 115, accuracy: 0.01)
        XCTAssertEqual(n.position(at: Date(timeIntervalSince1970: 5000)), 600, "never past the end")
        var p = n; p.playing = false
        XCTAssertEqual(p.position(at: Date(timeIntervalSince1970: 1010)), 100)
    }
}
