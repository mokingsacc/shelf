import SwiftUI
import ShelfWatchKit

/// The course ruler: one slice per episode (ticked in fg), with a notch at the next one
struct Ruler: View {
    var course: Course
    var fg: Color
    var height: CGFloat = 8
    var body: some View {
        Canvas { ctx, size in
            let n = max(1, course.total)
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(fg.opacity(0.22)))
            let w = size.width / CGFloat(n)
            if course.ticks.count == course.total {
                for (i, ch) in course.ticks.enumerated() where ch == "1" {
                    ctx.fill(Path(CGRect(x: CGFloat(i) * w, y: 0, width: w + 0.5, height: size.height)), with: .color(fg))
                }
            } else {
                ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width * CGFloat(course.fraction), height: size.height)), with: .color(fg))
            }
            if course.notch >= 0 {
                let x = min(size.width - 4, max(0, CGFloat(course.notch) * w + w / 2 - 2))
                let r = CGRect(x: x, y: (size.height - 14) / 2, width: 4, height: 14)
                ctx.fill(Path(r), with: .color(.black))
                ctx.stroke(Path(r), with: .color(fg), lineWidth: 1.5)
            }
        }
        .frame(height: max(height, 14))
        .accessibilityLabel("\(course.done) of \(course.total) done")
    }
}

/// Page 3, COURSES (design.md §3.10): the course on the go, big
struct CoursesPage: View {
    @EnvironmentObject var store: Store
    private let band = Band.medicine

    var body: some View {
        let list = store.snap?.courses ?? []
        let hero = list.first { $0.state == "go" } ?? list.first { $0.state == "new" } ?? list.first
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let c = hero {
                    Cap(text: c.state == "go" ? "Courses · on the go" : "Courses", color: band.fg.opacity(0.8))
                    Button { store.go(.course(c.id)) } label: { HeroCourse(course: c, band: band) }.buttonStyle(Press())
                    Rule(color: band.fg).padding(.top, 6)
                    Button { store.go(.allCourses) } label: {
                        HStack {
                            Cap(text: "All courses · \(list.count)", color: band.fg)
                            Spacer()
                            Text("›").font(.shelf(17, .heavy)).foregroundStyle(band.fg)
                        }
                        .frame(minHeight: Metric.tap)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                } else {
                    Cap(text: "Courses", color: band.fg.opacity(0.8))
                    Text("No courses yet. Add a playlist in Shelf on your iPhone.").font(.shelf(14, .regular)).foregroundStyle(band.fg).padding(.top, 8)
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .page(band.bg)
    }
}

/// A course's head: name and count, the ruler, what's next and the pace
struct HeroCourse: View {
    @EnvironmentObject var store: Store
    var course: Course
    var band: Band
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                FitTitle(text: course.name, color: band.fg)
                Spacer(minLength: 0)
                Text("\(course.done)/\(course.total)").font(.shelf(17, .semibold)).monospacedDigit().foregroundStyle(band.fg)
            }
            Ruler(course: course, fg: band.fg)
            if course.state == "new" && course.done == 0 {
                Meta(text: "Not started · \(course.total) videos", color: band.fg)
            } else if let n = course.next {
                Meta(text: "Next " + (n.label ?? "") + " · " + (n.short ?? n.title), color: band.fg)
            } else if course.finished {
                Meta(text: "All done", color: band.fg)
            }
            Meta(text: pace, color: band.fg.opacity(0.8))
        }
        .contentShape(Rectangle())
    }

    private var pace: String {
        let left = max(0, course.total - course.done)
        guard left > 0 else { return "\(course.total) ticked" }
        let days = max(1, store.snap?.step2?.days ?? 0)
        let perDay = Int((Double(left) / Double(days)).rounded(.up))
        return "\(left) left · \(perDay) a day"
    }
}

/// All courses (pushed): a mini ruler each; on the go first, Done folded
struct AllCoursesView: View {
    @EnvironmentObject var store: Store
    @State private var doneOpen = false
    private let band = Band.medicine

    var body: some View {
        let list = store.snap?.courses ?? []
        let open = list.filter { !$0.finished }
        let done = list.filter { $0.finished }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Cap(text: "All courses", color: band.fg.opacity(0.8)).padding(.bottom, 4)
                Rule(color: band.fg)
                Rows(items: open, color: band.fg) { c in row(c) }
                if !done.isEmpty {
                    Rule(color: band.fg, height: 2)
                    Button { doneOpen.toggle() } label: {
                        HStack(spacing: 4) {
                            Cap(text: "Done · \(done.count)", color: band.fg)
                            Image(systemName: doneOpen ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .heavy)).foregroundStyle(band.fg)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: Metric.tap).contentShape(Rectangle())
                    }
                    .buttonStyle(Press())
                    if doneOpen { Rows(items: done, color: band.fg) { c in row(c) } }
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .screen(band.bg)
    }

    private func row(_ c: Course) -> some View {
        Button { store.go(.course(c.id)) } label: {
            HStack(spacing: 6) {
                Text(c.name.uppercased()).font(.shelf(13, .heavy)).fontWidth(.condensed).lineLimit(1).foregroundStyle(band.fg).frame(width: 62, alignment: .leading)
                ProgressLine(fraction: c.fraction, fill: band.fg, track: band.fg.opacity(0.22), height: 4)
                Meta(text: "\(c.done)/\(c.total)", color: band.fg)
            }
            .frame(minHeight: Metric.tap)
            .contentShape(Rectangle())
        }
        .buttonStyle(Press())
    }
}

/// One course (design.md §3.10): next, IPHONE and TICK, and a window of 5 episodes to tick
struct CourseView: View {
    @EnvironmentObject var store: Store
    var id: String
    @State private var items: [Entry] = []
    @State private var from = 0
    @State private var count = 0
    @State private var loaded = false
    @State private var over: [String: Bool] = [:]     // ticks made here, until the iPhone's next snapshot
    @State private var undo: (key: String, label: String, queued: Bool)?
    @State private var problem: String?
    @State private var busy = false
    private let band = Band.medicine

    var body: some View {
        if let c = store.course(id) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    head(c)
                    if let n = c.next { next(c, n) }
                    if let problem { Text(problem).font(.shelf(12, .semibold)).foregroundStyle(Ink.wait).fixedSize(horizontal: false, vertical: true).padding(.top, 6) }
                    window(c)
                }
                .padding(.horizontal, Metric.inset)
                .padding(.bottom, undo == nil ? 0 : 56)
            }
            .screen(band.bg)
            .overlay(alignment: .bottom) {
                if let u = undo {
                    UndoBar(text: "Ticked " + u.label + (u.queued ? " · waits for iPhone" : ""), color: band.fg) { await tick(u.key, u.label, false, undoing: true) }
                }
            }
            .task { await load(c, from: nil) }
        } else {
            Text("This course is no longer in Shelf.").font(.shelf(14, .regular)).foregroundStyle(Ink.grey).screen(.black)
        }
    }

    private func head(_ c: Course) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                FitTitle(text: c.name, color: band.fg)
                Spacer(minLength: 0)
                Text("\(c.done)/\(c.total)").font(.shelf(17, .semibold)).monospacedDigit().foregroundStyle(band.fg)
            }
            Ruler(course: c, fg: band.fg)
            Meta(text: paceText(c), color: band.fg.opacity(0.8))
            Rule(color: band.fg).padding(.top, 4)
        }
    }

    private func paceText(_ c: Course) -> String {
        let left = max(0, c.total - c.done)
        guard left > 0 else { return "All \(c.total) ticked" }
        let days = max(1, store.snap?.step2?.days ?? 0)
        return "\(left) left · \(Int((Double(left) / Double(days)).rounded(.up))) a day"
    }

    private func next(_ c: Course, _ n: Entry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Cap(text: "Next · " + (n.label ?? ""), color: band.fg).padding(.top, 6)
            Text(n.short ?? n.title).font(.shelf(15, .bold)).lineLimit(2).foregroundStyle(band.fg)
            Meta(text: n.started ? "from " + Words.clock(n.t) + " / " + Words.clock(n.dur) : Words.clock(n.dur), color: band.fg.opacity(0.85))
            HStack(spacing: Metric.gap) {
                Button { Task { busy = true; problem = await Act.onPhone(n); busy = false } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "play.fill").font(.system(size: 12, weight: .black))
                        ButtonText(text: "iPhone", color: band.bg)
                    }
                    .foregroundStyle(band.bg)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(band.fg.opacity(busy ? 0.6 : 1))
                }
                .buttonStyle(Press())
                Button { Task { await tick(n.key, n.label ?? "", true) } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .black))
                        ButtonText(text: "Tick", color: band.fg)
                    }
                    .foregroundStyle(band.fg)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .overlay(Rectangle().strokeBorder(band.fg, lineWidth: 2))
                }
                .buttonStyle(Press())
            }
            .padding(.top, 4)
        }
    }

    @ViewBuilder private func window(_ c: Course) -> some View {
        if loaded {
            Rule(color: band.fg, height: 2).padding(.top, 8)
            if from > 0 {
                Button { Task { await load(c, from: max(0, from - 5), prepend: true) } } label: { Meta(text: "▲ \(from) earlier", color: band.fg).frame(maxWidth: .infinity, minHeight: Metric.tap, alignment: .leading) }
                    .buttonStyle(Press())
            }
            ForEach(items) { e in episode(c, e) }
            let after = count - (from + items.count)
            if after > 0 {
                Button { Task { await load(c, from: from + items.count, append: true) } } label: { Meta(text: "▼ \(after) more", color: band.fg).frame(maxWidth: .infinity, minHeight: Metric.tap, alignment: .leading) }
                    .buttonStyle(Press())
            }
        } else {
            Meta(text: store.live ? "Loading the episodes…" : "Open Shelf on your iPhone to see every episode.", color: band.fg.opacity(0.8)).padding(.top, 10)
        }
    }

    private func isOn(_ c: Course, _ e: Entry) -> Bool { over[e.key] ?? e.done }

    private func episode(_ c: Course, _ e: Entry) -> some View {
        let on = isOn(c, e)
        let isNext = c.next?.key == e.key
        return VStack(spacing: 0) {
            Rule(color: band.fg, height: isNext ? 3 : 0)
            HStack(spacing: 4) {
                Button { Task { await tick(e.key, e.label ?? "", !on) } } label: {
                    TickBox(on: on, band: band).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(Press())
                .accessibilityLabel((on ? "Untick " : "Tick ") + (e.label ?? ""))
                Button { store.go(.playOn(e, band: c.section)) } label: {
                    HStack(spacing: 4) {
                        Meta(text: (isNext ? "▸ " : "") + (e.label ?? ""), color: band.fg, size: 13, weight: .semibold)
                        Text(e.short ?? e.title).font(.shelf(13, .bold)).lineLimit(1).foregroundStyle(band.fg)
                        Spacer(minLength: 0)
                        Meta(text: e.dur > 0 ? Words.clock(e.dur) : "", color: band.fg.opacity(0.7), size: 11)
                    }
                    .frame(minHeight: Metric.tap)
                    .contentShape(Rectangle())
                }
                .buttonStyle(Press())
            }
            .opacity(on ? 0.5 : 1)
        }
    }

    private func load(_ c: Course, from f: Int?, prepend: Bool = false, append: Bool = false) async {
        var fields: [String: Any] = ["id": c.id, "n": 5]
        if let f { fields["from"] = f } else { fields["from"] = max(0, (c.notch < 0 ? c.total : c.notch) - 2) }
        let r = await store.send("course", fields)
        guard r.ok, let list = r.items else {
            if !loaded, let n = c.next { items = [n]; from = max(0, c.notch); count = c.total }
            loaded = !items.isEmpty
            return
        }
        count = r.count ?? c.total
        if prepend { items = list.filter { e in !items.contains { $0.key == e.key } } + items; from = r.from ?? 0 }
        else if append { items += list.filter { e in !items.contains { $0.key == e.key } } }
        else { items = list; from = r.from ?? 0 }
        loaded = true
    }

    private func tick(_ key: String, _ label: String, _ on: Bool, undoing: Bool = false) async {
        problem = nil
        let r = await Act.tick(course: id, key: key, on: on)
        guard r.ok else { problem = r.problem; return }
        over[key] = on
        if let i = items.firstIndex(where: { $0.key == key }) { items[i].done = on }
        undo = on && !undoing ? (key, label, r.queued) : nil
    }
}
