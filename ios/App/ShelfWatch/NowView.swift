import SwiftUI
import WatchKit
import ShelfWatchKit

/// Now, the remote (design.md §3.6): the same for the iPhone's playback and the watch's own, in the player or night palette.
/// The Crown is the volume of whatever plays (the iPhone's, or the watch's own). Holding −15 or +15 runs the time
/// back or on, faster the longer it's held, and it jumps there on letting go; a tap skips once.
struct NowView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer

    @State private var target: Double?              // holding a skip: it jumps here on letting go
    @State private var pressed: Double?             // the skip being pressed
    @State private var holding = false              // held past holdAfter: letting go jumps instead of skipping
    @State private var holdT = 0                    // each press's number, so an old press's timer does nothing
    @State private var shown = false                // on screen, so the Crown is ours
    @State private var marked: Double?              // Mark's frozen second, for 2 s
    @State private var problem: String?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
            if let s = Act.showing(store, player, at: ctx.date) {
                remote(s)
            } else {
                nothing
            }
        }
        .screen(.black)
        .navigationBarBackButtonHidden(false)
    }

    // MARK: Nothing playing

    private var nothing: some View {
        VStack(spacing: 10) {
            Spacer(minLength: 0)
            Cap(text: "Nothing playing")
            Button { store.path = []; store.tab = 0 } label: {
                ButtonText(text: "Pick up", color: Ink.ink).frame(width: 120, height: Metric.tap).overlay(Rectangle().strokeBorder(Ink.ink, lineWidth: 2))
            }
            .buttonStyle(Press())
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: The remote

    private func remote(_ s: Showing) -> some View {
        let pal = Palette.of(audio: !s.isVideo)
        let away = !s.onWatch && !store.reachable
        let ending = target == nil && s.ended && !s.onWatch
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .top, spacing: 4) {
                    VStack(alignment: .leading, spacing: 3) {
                        if let target {
                            holdHead(s, pal, target)
                        } else if ending {
                            nextHead(s, pal)
                        } else {
                            tag(s, pal, away)
                            // The only flexible line: two lines when there's room, one before anything else moves.
                            // A problem, or the phone's message, takes the title's place for a moment (design.md §4)
                            if let note = problem ?? (s.message.isEmpty || s.onWatch ? nil : s.message) {
                                Text(note).font(.shelf(13, .semibold)).foregroundStyle(Ink.wait).lineLimit(2).minimumScaleFactor(0.8)
                                    .layoutPriority(-1)
                            } else {
                                Text(s.title).font(.shelf(15, .heavy)).kerning(-0.2).lineLimit(2).foregroundStyle(pal.hi)
                                    .layoutPriority(-1)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // The Crown turns this: the iPhone's volume, or the watch's own while it plays here
                    Volume(phone: !s.onWatch, tint: pal.accent, active: shown)
                        .id(s.onWatch)
                        .frame(width: 30, height: 30)
                        .accessibilityLabel(s.onWatch ? "Watch volume" : "iPhone volume")
                }
                .layoutPriority(-1)
                Spacer(minLength: 2)
                if ending {
                    nextControls(s, pal)
                } else {
                    timeRow(s, pal)
                    controls(s, pal).opacity(away ? 0.4 : 1)
                }
            }
            .padding(.horizontal, Metric.inset)
            .padding(.top, 20)                      // below the system Back button, which floats over a screen that doesn't scroll
            .padding(.bottom, 6)
            transport(s, pal).opacity(away ? 0.4 : 1)
        }
        .ignoresSafeArea(edges: .bottom)
        .onAppear {
            shown = true
            // Demo screenshot of a hold (-holding): 2 min 15 back
            if store.demo, ProcessInfo.processInfo.arguments.contains("-holding") { pressed = -15; holding = true; target = max(0, s.t - 135) }
        }
        .onDisappear { shown = false; endHold() }
        .onChange(of: problem) { _, p in
            guard let p else { return }
            Task { try? await Task.sleep(nanoseconds: 4_000_000_000); if problem == p { withAnimation { problem = nil } } }
        }
    }

    private func tag(_ s: Showing, _ pal: Palette, _ away: Bool) -> some View {
        let color = away ? Ink.wait : (pal.night ? pal.mute : pal.accent)
        let text = away ? "iPhone out of reach" : (s.onWatch && s.message == "NO AIRPODS" ? "Paused · no AirPods" : (s.playing ? "" : "Paused · ") + s.tag)
        return HStack(spacing: 3) {
            Image(systemName: s.onWatch ? "applewatch" : "iphone").font(.system(size: 10, weight: .heavy))
            Cap(text: text, color: color, size: 11)
        }
        .foregroundStyle(color)
        .frame(height: 13)
    }

    private func timeRow(_ s: Showing, _ pal: Palette) -> some View {
        HStack(spacing: 6) {
            Meta(text: Words.clock(s.t), color: pal.hi, weight: .semibold)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Ink.dim)
                    Rectangle().fill(pal.accent).frame(width: g.size.width * CGFloat(s.dur > 0 ? min(1, s.t / s.dur) : 0))
                    if let target, s.dur > 0 {
                        Rectangle().fill(pal.accent).frame(width: 4, height: 12).offset(x: g.size.width * CGFloat(min(1, target / s.dur)) - 2)
                    }
                }
                .frame(height: 4)
                .frame(maxHeight: .infinity)
            }
            .frame(height: 16)
            Meta(text: s.dur > 0 ? "−" + Words.clock(max(0, s.dur - s.t)) : "", color: pal.mute)
        }
        .frame(height: 16)
    }

    private func controls(_ s: Showing, _ pal: Palette) -> some View {
        let outline = pal.night ? pal.rule : Ink.dim
        return HStack(spacing: Metric.gap) {
            if s.isVideo && !s.onWatch {
                Button { Task { await mark(s) } } label: {
                    Cell(outline: outline) {
                        VStack(spacing: 0) {
                            if marked != nil {
                                Image(systemName: "checkmark").font(.system(size: 10, weight: .black)).foregroundStyle(pal.accent)
                            } else { Cap(text: "Mark", color: pal.mute, size: 10) }
                            Meta(text: Words.clock(marked ?? s.t), color: marked != nil ? pal.accent : pal.text, size: 11, weight: .semibold)
                        }
                    }
                }
                .buttonStyle(Press())
            } else {
                Button { store.go(.sleep) } label: {
                    Cell(outline: outline) {
                        VStack(spacing: 0) {
                            Cap(text: "Timer", color: pal.mute, size: 10)
                            Meta(text: timerText(s), color: s.timer == nil ? pal.mute : pal.text, size: 11, weight: .semibold)
                        }
                    }
                }
                .buttonStyle(Press())
            }
            Button { store.go(.speed) } label: {
                Cell(outline: outline) { Text(Words.rate(s.rate)).font(.shelf(17, .semibold)).monospacedDigit().foregroundStyle(pal.text).minimumScaleFactor(0.7) }
            }
            .buttonStyle(Press())
            Button { store.go(.more) } label: {
                Cell(outline: outline) { Image(systemName: "ellipsis").font(.system(size: 17, weight: .bold)).foregroundStyle(pal.text) }
            }
            .buttonStyle(Press())
            .accessibilityLabel("More")
        }
        .frame(height: Metric.tap)
    }

    private func timerText(_ s: Showing) -> String {
        guard let t = s.timer else { return "Off" }
        if t.mode == "end" { return "End" }
        guard let end = t.endsDate else { return "\(t.minutes ?? 0)m" }
        return Words.countdown(end.timeIntervalSinceNow)
    }

    /// The transport band: −15 · play/pause · +15 (+30 for a podcast), pinned to the bottom edge
    private func transport(_ s: Showing, _ pal: Palette) -> some View {
        let ruleW: CGFloat = pal.night ? 2 : 3
        let ruleC = pal.night ? pal.rule : Ink.ink
        return VStack(spacing: 0) {
            Rectangle().fill(ruleC).frame(height: ruleW)
            HStack(spacing: 0) {
                skipCell("−15", s, -15, pal)
                Rectangle().fill(ruleC).frame(width: ruleW)
                centre(s, pal)
                Rectangle().fill(ruleC).frame(width: ruleW)
                skipCell("+" + String(Int(s.skip)), s, s.skip, pal)
            }
        }
        .frame(height: 60)
    }

    /// A tap skips once; held, it runs the time back or on and jumps there on letting go
    private func skipCell(_ text: String, _ s: Showing, _ by: Double, _ pal: Palette) -> some View {
        Text(text).font(.shelf(20, .semibold)).monospacedDigit().foregroundStyle(pal.night ? pal.text : Ink.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
            .opacity(pressed == by ? 0.6 : 1)
            // Touch down and lift (a long-press gesture ends when it's recognised, not when the finger lifts)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in press(s, by: by) }
                .onEnded { _ in lift(s, by: by) })
            .accessibilityElement()
            .accessibilityLabel(by < 0 ? "Back 15 seconds" : "Forward \(Int(by)) seconds")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { Task { await Act.skip(s, by: by) } }
    }

    private func centre(_ s: Showing, _ pal: Palette) -> some View {
        Button { Task { problem = await Act.toggle(s) } } label: {
            ZStack {
                if pal.night {
                    Color.black
                    Rectangle().strokeBorder(pal.mute, lineWidth: 2).frame(width: 40, height: 40)
                    Image(systemName: s.playing ? "pause.fill" : "play.fill").font(.system(size: 22, weight: .bold)).foregroundStyle(pal.hi)
                } else if s.playing {
                    pal.accent
                    Image(systemName: "pause.fill").font(.system(size: 22, weight: .bold)).foregroundStyle(.black)
                } else {
                    Color.black
                    Image(systemName: "play.fill").font(.system(size: 22, weight: .bold)).foregroundStyle(pal.accent)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .buttonStyle(Press())
        .accessibilityLabel(s.playing ? "Pause" : "Play")
    }

    // MARK: Next up (the phone's end-of-video card)

    @ViewBuilder private func nextHead(_ s: Showing, _ pal: Palette) -> some View {
        // The tag's place ("92 of 130") is the one that ended, so only the course or channel is kept
        let from = s.tag.components(separatedBy: " · ").first ?? s.tag
        Cap(text: s.next != nil ? "Next up · " + from : s.tag, color: s.next != nil ? (pal.night ? pal.mute : pal.accent) : pal.mute).frame(height: 13)
        if let problem {
            Text(problem).font(.shelf(13, .semibold)).foregroundStyle(Ink.wait).lineLimit(2).minimumScaleFactor(0.8).layoutPriority(-1)
        } else if let n = s.next {
            Text(n.label + " · " + n.title).font(.shelf(15, .heavy)).lineLimit(2).foregroundStyle(pal.hi).layoutPriority(-1)
        } else {
            Text("End of the playlist").font(.shelf(15, .heavy)).lineLimit(2).foregroundStyle(pal.hi).layoutPriority(-1)
        }
    }

    /// In place of the time row and the control row: the countdown, then Play next and Stop (or Done at the end of a list)
    @ViewBuilder private func nextControls(_ s: Showing, _ pal: Palette) -> some View {
        if s.next != nil {
            Meta(text: s.autoNext ? Self.countdown(store.phoneNow?.at) : "Ended", color: pal.mute).frame(height: 16)
            HStack(spacing: Metric.gap) {
                Button { Task { problem = await Act.next() } } label: { Cell(fill: pal.accent, outline: nil) { ButtonText(text: "Play next", color: .black, size: 12) } }.buttonStyle(Press())
                Button { Task { await Act.stop(s) } } label: { Cell(outline: Ink.dim) { ButtonText(text: "Stop", color: pal.text, size: 12) } }.buttonStyle(Press())
                    .frame(width: Metric.third)
            }
            .frame(height: Metric.tap)
        } else {
            Meta(text: "Ended", color: pal.mute).frame(height: 16)
            Button { store.path = []; store.tab = 0 } label: { Cell(outline: Ink.dim) { ButtonText(text: "Done", color: pal.text) } }.buttonStyle(Press())
                .frame(height: Metric.tap)
        }
    }

    /// The phone plays the next one 5 s after the end (Now redraws every half second)
    static func countdown(_ at: Double?, now: Date = Date()) -> String {
        guard let at else { return "Plays in 5 s" }
        let left = Int((5 - (now.timeIntervalSince1970 * 1000 - at) / 1000).rounded(.up))
        return left > 0 ? "Plays in \(min(5, left)) s" : "Starting…"
    }

    // MARK: Holding a skip

    static let holdAfter = 0.4

    private func holdHead(_ s: Showing, _ pal: Palette, _ to: Double) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Cap(text: holding ? "Let go to jump" : "Jumping", color: pal.accent)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Words.clock(to)).font(.shelf(30, .semibold)).monospacedDigit().foregroundStyle(pal.hi).minimumScaleFactor(0.6).lineLimit(1)
                let d = to - s.t
                Meta(text: (d < 0 ? "−" : "+") + Words.clock(abs(d)), color: pal.mute)
            }
        }
    }

    private func press(_ s: Showing, by: Double) {
        guard pressed == nil else { return }        // onChanged runs on every move; only the touch down counts
        pressed = by
        holding = false
        holdT += 1
        let mine = holdT
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(Self.holdAfter * 1_000_000_000))
            guard mine == holdT, pressed == by else { return }
            startHold(s, by: by, mine)
        }
    }

    private func startHold(_ s: Showing, by: Double, _ mine: Int) {
        guard s.dur > 0 else { return }             // nothing to run along: letting go is a plain skip
        holding = true
        let began = Date()
        withAnimation(.easeOut(duration: 0.15)) { target = Rules.holdMove(s.t, by: by, dur: s.dur) }
        Haptic.select()
        Task { @MainActor in
            while true {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard mine == holdT, holding, let from = target else { return }
                let step = Rules.holdStep(abs(by), held: Date().timeIntervalSince(began), dur: s.dur)
                let to = Rules.holdMove(from, by: by < 0 ? -step : step, dur: s.dur)
                if to == from { continue }          // at the start or the end: it waits there
                target = to
                Haptic.select()
            }
        }
    }

    private func lift(_ s: Showing, by: Double) {
        guard pressed == by else { return }
        let held = holding, to = target
        pressed = nil
        holding = false
        holdT += 1
        if held, let to {
            Task { await jump(s, to: to) }
        } else {
            Task { await Act.skip(s, by: by) }
        }
    }

    /// Ends a press without skipping or jumping (leaving the screen)
    private func endHold() {
        holdT += 1
        pressed = nil
        holding = false
        target = nil
    }

    private func jump(_ s: Showing, to: Double) async {
        _ = await Act.seek(s, to: to)
        // A new hold may have started while the phone answered; that one keeps its target
        if !holding, target == to { withAnimation(.easeOut(duration: 0.15)) { target = nil } }
    }

    private func mark(_ s: Showing) async {
        let at = s.t
        marked = at
        let ok = await Act.mark(at: at)
        if !ok { marked = nil; problem = Words.why(store.live ? "error" : "asleep"); return }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        marked = nil
    }
}

/// Speed (design.md §3.7): 3 cells over 2; a tap applies it and goes back to Now
struct SpeedView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let s = Act.showing(store, player)
        let pal = Palette.of(audio: !(s?.isVideo ?? false))
        let rates = (s?.isVideo ?? true) ? (store.snap?.rates.video ?? Rates.standard.video) : (store.snap?.rates.audio ?? Rates.standard.audio)
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.gap) {
                Cap(text: "Speed" + (s.map { " · " + $0.tag } ?? ""))
                grid(rates, s, pal)
                Meta(text: "Remembered for " + (s?.tag.isEmpty == false ? s!.tag.capitalized : "this channel")).padding(.top, 2)
            }
            .padding(.horizontal, Metric.inset)
        }
        .screen(.black)
    }

    @ViewBuilder private func grid(_ rates: [Double], _ s: Showing?, _ pal: Palette) -> some View {
        let top = Array(rates.prefix(3)), bottom = Array(rates.dropFirst(3))
        HStack(spacing: Metric.gap) { ForEach(top, id: \.self) { r in cell(r, s, pal) } }
        HStack(spacing: Metric.gap) { ForEach(bottom, id: \.self) { r in cell(r, s, pal) } }
    }

    private func cell(_ r: Double, _ s: Showing?, _ pal: Palette) -> some View {
        let lit = s.map { abs($0.rate - r) < 0.01 } ?? false
        let label = (r == 1 || r == 2) ? Words.rate(r) : String(format: "%g", r)
        return Button {
            guard let s else { return }
            Task { await Act.rate(s, r); dismiss() }
        } label: {
            Cell(fill: lit ? pal.accent : .black, outline: lit ? nil : Ink.dim, height: 52) {
                Text(label).font(.shelf(17, .semibold)).monospacedDigit().foregroundStyle(lit ? Color.black : Ink.ink)
            }
        }
        .buttonStyle(Press())
    }
}

/// Sleep timer (design.md §3.7): 15 30 45 / 60 END OFF. The lit one turns it off, as on the phone.
struct SleepView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let s = Act.showing(store, player)
        let pal = Palette.of(audio: !(s?.isVideo ?? false))
        ScrollView {
            VStack(alignment: .leading, spacing: Metric.gap) {
                Cap(text: "Sleep timer")
                TimelineView(.periodic(from: .now, by: 1)) { ctx in Meta(text: readout(s?.timer, ctx.date), color: Ink.ink) }
                HStack(spacing: Metric.gap) { ForEach(["15", "30", "45"], id: \.self) { m in cell(m, s, pal) } }
                HStack(spacing: Metric.gap) { ForEach(["60", "end", "off"], id: \.self) { m in cell(m, s, pal) } }
            }
            .padding(.horizontal, Metric.inset)
        }
        .screen(.black)
    }

    private func readout(_ t: SleepState?, _ now: Date) -> String {
        guard let t else { return "Off" }
        if t.mode == "end" { return "Stops when this ends" }
        guard let end = t.endsDate else { return "On" }
        return Words.countdown(end.timeIntervalSince(now)) + " left · stops " + Store.clock(end)
    }

    private func isLit(_ m: String, _ t: SleepState?) -> Bool {
        guard let t else { return m == "off" }
        if m == "end" { return t.mode == "end" }
        return t.mode == "min" && String(t.minutes ?? -1) == m
    }

    private func cell(_ m: String, _ s: Showing?, _ pal: Palette) -> some View {
        let lit = isLit(m, s?.timer)
        return Button {
            guard let s else { return }
            // Tapping the lit one turns the timer off
            let choice = lit && m != "off" ? "off" : m
            Task { await Act.timer(s, choice); dismiss() }
        } label: {
            Cell(fill: lit ? pal.accent : .black, outline: lit ? nil : Ink.dim, height: 52) {
                Text(m.uppercased()).font(.shelf(m.count > 2 ? 13 : 17, m.count > 2 ? .black : .semibold)).monospacedDigit().foregroundStyle(lit ? Color.black : Ink.ink)
            }
        }
        .buttonStyle(Press())
    }
}

/// More (design.md §3.8): only the rows that apply, 4 at most
struct MoreView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer
    @Environment(\.dismiss) private var dismiss
    @State private var problem: String?
    @State private var busy = false
    @State private var twin: Twin?
    @State private var looked = false

    var body: some View {
        let s = Act.showing(store, player)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let s {
                    if s.isVideo {
                        row("Sleep timer", s.timer.map { Words.sleep($0) } ?? "Off") { store.go(.sleep) }
                    }
                    if let n = s.next, !s.onWatch {
                        row("Next", n.label + " · " + n.title) { Task { problem = await Act.next(); if problem == nil { dismiss() } } }
                    }
                    if s.notes, !s.onWatch {
                        row("Notes", "The summary") { store.go(.notes(s.key)) }
                    }
                    if s.isVideo, !s.onWatch, let tw = twin {
                        row("Listen on watch", "podcast version from " + Words.clock(tw.linked ? s.t : tw.start)) { Task { await listen(s, tw) } }
                    } else if s.isVideo, !s.onWatch, !looked {
                        row("Listen on watch", "Looking for a podcast version…") {}
                    }
                    if !s.isVideo && !s.onWatch {
                        row("Move to watch", "carry on from " + Words.clock(s.t)) { Task { busy = true; problem = await Act.moveToWatch(s); busy = false } }
                    }
                    if s.onWatch {
                        row("Move to iPhone", "carry on from " + Words.clock(s.t)) { Task { busy = true; problem = await Act.moveToPhone(); busy = false } }
                        row("Stop", "ends it on the watch") { Task { await Act.stop(s); store.path = []; store.tab = 0 } }
                    }
                }
                if let problem {
                    Text(problem).font(.shelf(12, .semibold)).foregroundStyle(Ink.wait).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                }
            }
            .padding(.horizontal, Metric.inset)
            .opacity(busy ? 0.6 : 1)
        }
        .screen(.black)
        .task { await findTwin(s) }
    }

    private func row(_ label: String, _ text: String, _ go: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            Button(action: go) { LabelRow(label: label, text: text, chevron: true).frame(minHeight: 52) }.buttonStyle(Press())
            Rule(color: Ink.hair, height: 2)
        }
    }

    private func findTwin(_ s: Showing?) async {
        guard let s, s.isVideo, !s.onWatch, store.live else { looked = true; return }
        let r = await store.send("twin", ["key": s.key])
        if r.ok, let tw = r.twin, !tw.url.isEmpty { twin = tw }
        looked = true
    }

    private func listen(_ s: Showing, _ tw: Twin) async {
        busy = true
        let video = Entry(type: "video", key: s.key, title: s.title, srcName: s.tag, dur: s.dur, t: s.t)
        problem = await Act.onWatch(Act.watchItem(tw, video: video), from: tw.linked ? max(0, s.t - 2) : tw.start)
        busy = false
    }
}

/// Notes (design.md §3.9): the Gemini summary, read with the Crown
struct NotesView: View {
    @EnvironmentObject var store: Store
    var key: String
    @State private var summary: Summary?
    @State private var state = "loading"      // loading, none, working, noai, away

    var body: some View {
        let onNow = store.phoneNow?.key == key
        let pal = Palette.of(audio: false)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Cap(text: "Notes" + (onNow ? " · " + (store.phoneNow?.tag ?? "") : ""), color: pal.accent)
                if let summary {
                    Text(summary.gist).font(.shelf(16, .heavy)).foregroundStyle(Ink.ink).fixedSize(horizontal: false, vertical: true).padding(.vertical, 4)
                    Rule()
                    ForEach(Array(summary.points.prefix(6).enumerated()), id: \.offset) { i, p in
                        if i > 0 { Rule(color: Ink.hair, height: 2) }
                        point(p, onNow, pal)
                    }
                } else {
                    Text(message).font(.shelf(14, .regular)).foregroundStyle(Ink.grey).fixedSize(horizontal: false, vertical: true).padding(.vertical, 6)
                    if state == "none" {
                        Button { Task { await load(make: true) } } label: {
                            ButtonText(text: "Make notes", color: Ink.ink).frame(maxWidth: .infinity, minHeight: Metric.tap).overlay(Rectangle().strokeBorder(Ink.ink, lineWidth: 2))
                        }
                        .buttonStyle(Press())
                    }
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .screen(.black)
        .task { await load(make: false) }
    }

    private var message: String {
        switch state {
        case "loading": return "Loading from your iPhone…"
        case "working": return "Writing the notes on your iPhone…"
        case "noai": return Words.why("noai")
        case "away": return "Open Shelf on your iPhone to load the notes."
        default: return "No notes for this video yet."
        }
    }

    private func point(_ p: NotePoint, _ onNow: Bool, _ pal: Palette) -> some View {
        HStack(alignment: .top, spacing: 6) {
            if let t = p.t {
                if onNow {
                    Button { Haptic.select(); Task { _ = await store.send("seekTo", ["t": t]) } } label: {
                        Meta(text: Words.clock(t), color: pal.accent, size: 13, weight: .semibold).frame(width: 48, height: 44).overlay(Rectangle().strokeBorder(Ink.dim, lineWidth: 2))
                    }
                    .buttonStyle(Press())
                } else {
                    Meta(text: Words.clock(t), color: Ink.grey, size: 13, weight: .semibold).frame(width: 48, alignment: .leading).padding(.top, 2)
                }
            }
            Text(p.text).font(.shelf(14, .regular)).lineSpacing(2).foregroundStyle(Ink.ink).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
    }

    private func load(make: Bool) async {
        if make { state = "working" }
        for _ in 0..<(make ? 24 : 1) {
            let r = await store.send("notes", ["key": key, "make": make])
            if let s = r.summary { summary = s; return }
            if r.why == "noai" { state = "noai"; return }
            if !r.ok { state = "away"; return }
            state = r.working == true ? "working" : "none"
            if state != "working" { return }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }
}

/// The Crown's volume (the system's own control, as in Now Playing): the iPhone's while it plays there, else the watch's.
/// SwiftUI takes the Crown back after a tap, so while Now is on screen the control asks for it again every 0.3 s.
struct Volume: WKInterfaceObjectRepresentable {
    typealias WKInterfaceObjectType = WKInterfaceVolumeControl
    var phone: Bool
    var tint: Color
    var active: Bool

    final class Keeper {
        var active = false
        var timer: Timer?
        deinit { timer?.invalidate() }
    }

    func makeCoordinator() -> Keeper { Keeper() }

    func makeWKInterfaceObject(context: WKInterfaceObjectRepresentableContext<Volume>) -> WKInterfaceVolumeControl {
        let v = WKInterfaceVolumeControl(origin: phone ? .companion : .local)
        v.setTintColor(UIColor(tint))
        let keeper = context.coordinator
        keeper.active = active
        keeper.timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak v, weak keeper] t in
            guard let v, let keeper else { t.invalidate(); return }
            if keeper.active { v.focus() }
        }
        DispatchQueue.main.async { [weak v] in if active { v?.focus() } }
        return v
    }

    func updateWKInterfaceObject(_ v: WKInterfaceVolumeControl, context: WKInterfaceObjectRepresentableContext<Volume>) {
        v.setTintColor(UIColor(tint))
        let was = context.coordinator.active
        context.coordinator.active = active
        if active && !was { v.focus() } else if !active && was { v.resignFocus() }
    }
}
