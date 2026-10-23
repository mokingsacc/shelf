import SwiftUI
import ShelfWatchKit

/// Play on (design.md §3.5): every item tap opens this. iPhone left, Watch right, equal weight, nothing pre-chosen.
struct PlayOnView: View {
    @EnvironmentObject var store: Store
    var entry: Entry
    var bandID: String

    @State private var twin: Twin?
    @State private var looking = false
    @State private var lookedUp = false
    @State private var busy: String?            // "phone" or "watch" while it starts
    @State private var problem: String?
    @State private var ticked: Bool?
    @State private var undo: String?

    private var band: Band { Band.of(section: entry.course != nil ? (store.course(entry.course!)?.section ?? "med") : bandID, in: store.snap) }

    /// What the watch plays for this: the episode itself, or the video's podcast version
    private var watchItem: WatchItem? {
        if let it = Act.watchItem(entry) { return it }
        if let twin, !twin.url.isEmpty { return Act.watchItem(twin, video: entry) }
        return nil
    }

    var body: some View {
        let b = band
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Cap(text: heading, color: b.fg.opacity(0.85))
                Text(entry.title).font(.shelf(15, .heavy)).kerning(-0.2).lineLimit(3).foregroundStyle(b.fg)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 1)
                Meta(text: meta, color: b.fg.opacity(0.85)).padding(.top, 2).padding(.bottom, 8)
                choice(b)
                if let problem {
                    Text(problem).font(.shelf(12, .semibold)).foregroundStyle(Ink.wait).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                }
                extras(b)
            }
            .padding(.horizontal, Metric.inset)
            .padding(.bottom, undo == nil ? 0 : 56)
        }
        .screen(b.bg)
        .overlay(alignment: .bottom) { if let undo { UndoBar(text: undo, color: b.fg) { await untick() } } }
        .task { await findTwin() }
    }

    private var heading: String {
        if entry.course != nil, let c = store.course(entry.course!) { return c.name + " · " + (entry.label ?? "") }
        let sec = store.section(bandID)?.name ?? ""
        return [sec, entry.srcName].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var meta: String {
        if entry.started { return "from " + Words.clock(entry.t) + " · " + Words.left(entry.t, entry.dur) }
        if entry.isNew { return "new" + (entry.dur > 0 ? " · " + Words.clock(entry.dur) : "") }
        if entry.done { return "watched · " + Words.clock(entry.dur) }
        return (entry.isAudio ? "episode" : "video") + (entry.dur > 0 ? " · " + Words.clock(entry.dur) : "")
    }

    @ViewBuilder private func choice(_ b: Band) -> some View {
        if watchItem != nil {
            HStack(spacing: Metric.gap) {
                square(b, icon: "iphone", name: "iPhone", sub: store.live ? (entry.isAudio ? "episode" : "video") : "open Shelf first", which: "phone", dim: !store.live) { await playPhone() }
                square(b, icon: "applewatch", name: "Watch", sub: watchSub, which: "watch", dim: false) { await playWatch() }
            }
        } else {
            Button { Task { await playPhone() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "iphone").font(.system(size: 18, weight: .bold))
                    ButtonText(text: "Play on iPhone", color: b.onFill)
                }
                .foregroundStyle(b.onFill)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(busy == "phone" ? b.fill.opacity(0.6) : b.fill)
            }
            .buttonStyle(Press())
            .disabled(busy != nil)
            Meta(text: looking ? "Looking for a podcast version…" : "Phone only", color: b.fg.opacity(0.6)).frame(maxWidth: .infinity).padding(.top, 4)
        }
    }

    private var watchSub: String { entry.isAudio ? "episode" : "podcast" }

    private func square(_ b: Band, icon: String, name: String, sub: String, which: String, dim: Bool, go: @escaping () async -> Void) -> some View {
        Button { Task { await go() } } label: {
            VStack(spacing: 2) {
                Image(systemName: icon).font(.system(size: 20, weight: .semibold))
                ButtonText(text: name, color: dim ? Ink.grey : b.fg)
                Text(sub).font(.shelf(10, .medium)).foregroundStyle((dim ? Ink.grey : b.fg).opacity(0.75)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(dim ? Ink.grey : b.fg)
            .frame(maxWidth: .infinity, minHeight: 64)
            .background(busy == which ? b.fg.opacity(0.2) : Color.black)
            .overlay(Rectangle().strokeBorder(dim ? Ink.dim : b.fg, lineWidth: 2))
        }
        .buttonStyle(Press())
        .disabled(busy != nil)
        .accessibilityLabel("Play on " + name)
    }

    @ViewBuilder private func extras(_ b: Band) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.phoneNow?.key == entry.key && store.phoneNow?.notes == true {
                Rule(color: b.fg, height: 2).padding(.top, 8)
                Button { store.go(.notes(entry.key)) } label: { LabelRow(label: "Notes", text: "The summary", labelColor: b.fg.opacity(0.8), textColor: b.fg, chevron: true) }.buttonStyle(Press())
            }
            if let course = entry.course, let label = entry.label {
                let on = ticked ?? entry.done
                Rule(color: b.fg, height: 2).padding(.top, 8)
                Button { Task { await tick(course, label, !on) } } label: {
                    HStack(spacing: 8) {
                        TickBox(on: on, band: b)
                        ButtonText(text: (on ? "Ticked " : "Tick ") + label, color: b.fg)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: Metric.tap)
                }
                .buttonStyle(Press())
            }
        }
    }

    // MARK: Doing it

    private func findTwin() async {
        guard entry.isVideo, !lookedUp, store.live else { return }
        lookedUp = true
        looking = true
        let r = await store.send("twin", ["key": entry.key, "entry": Command.fields(entry)])
        looking = false
        if r.ok, let tw = r.twin, !tw.url.isEmpty { twin = tw }
    }

    private func playPhone() async {
        busy = "phone"; problem = nil
        problem = await Act.onPhone(entry)
        busy = nil
    }

    private func playWatch() async {
        guard let it = watchItem else { return }
        busy = "watch"; problem = nil
        let from: Double
        if let twin { from = twin.linked ? max(twin.start, entry.t) : twin.start } else { from = Act.start(entry) }
        problem = await Act.onWatch(it, from: from)
        busy = nil
    }

    private func tick(_ course: String, _ label: String, _ on: Bool) async {
        let r = await Act.tick(course: course, key: entry.key, on: on)
        if r.ok { ticked = on; undo = on ? "Ticked " + label + (r.queued ? " · waits for iPhone" : "") : nil } else { problem = r.problem }
    }

    private func untick() async {
        guard let course = entry.course else { return }
        let r = await Act.tick(course: course, key: entry.key, on: false)
        if r.ok { ticked = false }
        undo = nil
    }
}

/// The tick box: 24×24, a 2 pt outline; ticked is filled with a checkmark
struct TickBox: View {
    var on: Bool
    var band: Band
    var body: some View {
        ZStack {
            if on { band.fill; Image(systemName: "checkmark").font(.system(size: 14, weight: .black)).foregroundStyle(band.onFill) }
        }
        .frame(width: 24, height: 24)
        .overlay(Rectangle().strokeBorder(band.fg, lineWidth: 2))
    }
}

/// The Undo bar, pinned to the bottom for 5 s; the whole bar is the button
struct UndoBar: View {
    var text: String
    var color: Color
    var undo: () async -> Void
    @State private var gone = false
    var body: some View {
        ZStack {
            if !gone {
                Button { Haptic.select(); Task { await undo() } } label: {
                    HStack(spacing: 8) {
                        Meta(text: text, color: Ink.ink)
                        ButtonText(text: "Undo", color: color)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(Ink.hair)
                }
                .buttonStyle(Press())
                .transition(.opacity)
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .task(id: text) {
            gone = false
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            withAnimation(.easeOut(duration: 0.15)) { gone = true }
        }
    }
}
