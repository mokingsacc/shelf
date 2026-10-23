import Foundation
import ShelfWatchKit

/// Demo mode, for the screenshots CI takes in the simulator (launched with -demo -screen <name>): a real snapshot
/// recorded from Shelf's page (demo.json), canned answers, and a screen to open. Never used on a real watch.
@MainActor
enum Demo {
    static func open(_ store: Store) {
        guard store.demo else { return }
        let args = ProcessInfo.processInfo.arguments
        let screen = args.firstIndex(of: "-screen").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "today"
        let snap = store.snap
        let med = snap?.sections.first { $0.id == "med" }
        let sleep = snap?.sections.first { $0.id == "sleep" }
        let course = snap?.courses.first { $0.next != nil }
        switch screen {
        case "sections": store.tab = 1
        case "courses": store.tab = 2
        case "step2": store.tab = 3
        case "check": store.tab = 4
        case "section": store.tab = 1; store.path = [.section("med")]
        case "channel": if let c = med?.channels.first { store.tab = 1; store.path = [.section("med"), .channel(c, section: "med")] }
        case "playon": if let e = med?.items.first { store.path = [.playOn(e, band: "med")] }
        case "playon-sleep": if let e = sleep?.items.first { store.path = [.playOn(e, band: "sleep")] }
        case "now": store.path = [.now]
        case "now-watch":
            if let e = sleep?.items.first, let it = Act.watchItem(e) { WatchPlayer.shared.demo(it, t: 1450, playing: true) }
            store.path = [.now]
        case "speed": store.path = [.now, .speed]
        case "sleep": store.path = [.now, .sleep]
        case "more": store.path = [.now, .more]
        case "notes": if let n = store.phoneNow { store.path = [.now, .notes(n.key)] }
        case "course": if let c = course { store.tab = 2; store.path = [.course(c.id)] }
        case "allcourses": store.tab = 2; store.path = [.allCourses]
        default: break
        }
    }

    static func reply(_ name: String, _ f: [String: Any], store: Store) -> Reply {
        func decode(_ o: [String: Any]) -> Reply {
            (try? JSONSerialization.data(withJSONObject: o)).flatMap(Reply.decode) ?? Reply(ok: true)
        }
        switch name {
        case "course":
            guard let c = store.course(f["id"] as? String ?? ""), let n = c.next else { return Reply(ok: false, why: "missing") }
            let from = (f["from"] as? Int) ?? max(0, c.notch - 2)
            let items: [[String: Any]] = (0..<5).map { j in
                let i = from + j
                return ["type": "video", "key": "demo\(i)", "title": n.title, "srcName": n.srcName, "dur": 600 + (i * 37) % 300, "t": 0, "done": c.ticked(i),
                        "course": c.id, "label": String(1000 + i * 8), "short": n.short ?? "Episode"]
            }
            return decode(["ok": true, "items": items, "from": from, "count": c.total, "notch": c.notch, "done": c.done, "total": c.total])
        case "twin":
            return decode(["ok": true, "twin": ["guid": "demo-twin", "url": "https://example.com/a.mp3", "title": "The podcast version", "podcast": "Demo", "dur": 3000, "linked": true, "start": 252]])
        case "notes":
            return decode(["ok": true, "summary": ["gist": "Hyperkalaemia: stabilise the heart with calcium first, then shift potassium into cells, then remove it.",
                                                    "points": [["t": 42, "text": "Peaked T waves, then a widening QRS: give calcium gluconate."],
                                                               ["t": 190, "text": "Insulin with glucose and salbutamol shift potassium into cells."],
                                                               ["t": 410, "text": "Remove it: loop diuretics, binders, or dialysis."]]]])
        case "channel", "section":
            return decode(["ok": true, "items": (store.section("med")?.items ?? []).map { Command.fields($0) }])
        default:
            return Reply(ok: true)
        }
    }
}
