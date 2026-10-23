import SwiftUI
import AVFoundation
import ShelfWatchKit

/// Page 4, STEP 2 (design.md §3.11): the days to the exam, today, and the week
struct Step2Page: View {
    @EnvironmentObject var store: Store
    private let band = Band.entertainment

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let s = store.snap?.step2 {
                    if s.past { done(s) } else { counting(s) }
                } else {
                    Cap(text: "Step 2", color: band.fg)
                    Text("Set your exam date in Shelf on your iPhone.").font(.shelf(14, .regular)).foregroundStyle(band.fg).padding(.top, 6)
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .page(band.bg)
    }

    private func counting(_ s: Step2) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Cap(text: "Days to " + s.goal, color: band.fg.opacity(0.8))
            HStack(alignment: .lastTextBaseline, spacing: 6) {
                Text("\(max(0, s.days))").font(.shelf(54, .medium)).fontWidth(.expanded).kerning(-2).monospacedDigit().foregroundStyle(band.fg).lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                Cap(text: dateText(s.date), color: band.fg).padding(.bottom, 8)
            }
            Rule(color: band.fg).padding(.bottom, 4)
            (Text("Today ").font(.shelf(13, .medium)) + Text("\(s.today)").font(.shelf(13, .semibold)) + Text(" · ").font(.shelf(13, .medium))
                + Text("\(s.todayMins) min").font(.shelf(13, .semibold)))
                .monospacedDigit().foregroundStyle(band.fg)
            if s.perDay > 0 {
                (Text(String(format: "%g", s.perDay)).font(.shelf(13, .semibold)) + Text(" a day to finish").font(.shelf(13, .medium)))
                    .monospacedDigit().foregroundStyle(band.fg)
            }
            Week(week: s.week, fg: band.fg).padding(.top, 5)
            Meta(text: "This week \(s.week.reduce(0, +))", color: band.fg.opacity(0.8)).padding(.top, 2)
        }
    }

    private func done(_ s: Step2) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Cap(text: s.goal, color: band.fg.opacity(0.8))
            Image(systemName: "checkmark").font(.system(size: 40, weight: .black)).foregroundStyle(band.fg)
            Text("Set a new goal in Shelf on your iPhone.").font(.shelf(14, .regular)).foregroundStyle(band.fg)
        }
    }

    private func dateText(_ iso: String) -> String {
        let p = DateFormatter(); p.dateFormat = "yyyy-MM-dd"; p.locale = Locale(identifier: "en_GB")
        guard let d = p.date(from: iso) else { return "" }
        let f = DateFormatter(); f.dateFormat = "EEE d MMM"; f.locale = Locale(identifier: "en_GB")
        return f.string(from: d)
    }
}

/// Seven bars, today last and outlined; empty days are a short stub
struct Week: View {
    var week: [Int]
    var fg: Color
    var body: some View {
        let top = max(1, week.max() ?? 1)
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(week.enumerated()), id: \.offset) { i, n in
                ZStack(alignment: .bottom) {
                    Rectangle().fill(n > 0 ? fg : fg.opacity(0.25)).frame(height: n > 0 ? max(4, 24 * CGFloat(n) / CGFloat(top)) : 3)
                }
                .frame(maxWidth: .infinity, minHeight: 24, maxHeight: 24, alignment: .bottom)
                .overlay(Rectangle().strokeBorder(i == week.count - 1 ? fg : .clear, lineWidth: 2))
            }
        }
        .frame(height: 24)
    }
}

/// Page 5, CHECK (design.md §3.12): the app explains itself in plain words
struct CheckPage: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer
    @State private var syncing = false

    struct Line: Identifiable { var id: Int; var ok: Bool?; var text: String }

    var body: some View {
        let lines = self.lines
        let bad = lines.filter { $0.ok == false }.count
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Rectangle().fill(bad == 0 ? Ink.ok : Ink.wait).frame(width: 24, height: 24)
                    Text(bad == 0 ? "All good" : bad == 1 ? "One thing to fix" : "\(bad) things to fix").font(.shelf(18, .black)).foregroundStyle(Ink.ink).lineLimit(1).minimumScaleFactor(0.7)
                }
                Meta(text: "Checked " + Store.clock(store.checkedAt)).padding(.top, 3).padding(.bottom, 6)
                Rule()
                ForEach(lines.sorted { ($0.ok == false ? 0 : 1, $0.id) < ($1.ok == false ? 0 : 1, $1.id) }) { l in
                    HStack(alignment: .top, spacing: 6) {
                        if let ok = l.ok { Rectangle().fill(ok ? Ink.ok : Ink.wait).frame(width: 10, height: 10).padding(.top, 3) }
                        Text(l.text).font(.shelf(13, .regular)).foregroundStyle(l.ok == nil ? Ink.grey : Ink.ink).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 6)
                    Rule(color: Ink.hair, height: 2)
                }
                Button { Task { await sync() } } label: {
                    ButtonText(text: syncing ? "Syncing…" : "Sync now", color: Ink.ink).frame(maxWidth: .infinity, minHeight: Metric.tap).overlay(Rectangle().strokeBorder(Ink.ink, lineWidth: 2))
                }
                .buttonStyle(Press())
                .padding(.top, 8)
            }
            .padding(.horizontal, Metric.inset)
        }
        .page(.black)
    }

    private var lines: [Line] {
        var out: [Line] = []
        let shown = store.snap.map { Store.clock($0.date) } ?? "nothing yet"
        if store.live { out.append(Line(id: 1, ok: true, text: "iPhone connected, Shelf open")) }
        else if store.reachable { out.append(Line(id: 1, ok: false, text: "Open Shelf on your iPhone to control it")) }
        else { out.append(Line(id: 1, ok: false, text: "iPhone out of reach. Showing " + shown)) }
        if store.waiting > 0 { out.append(Line(id: 2, ok: false, text: "\(store.waiting) change" + (store.waiting == 1 ? "" : "s") + " wait for your iPhone")) }
        else { out.append(Line(id: 2, ok: true, text: "Synced " + (store.heardAt.map { Words.ago($0) } ?? "not yet"))) }
        if player.headphones { out.append(Line(id: 3, ok: true, text: (player.lastRoute.isEmpty ? "AirPods" : player.lastRoute) + " connected to this watch")) }
        else { out.append(Line(id: 3, ok: nil, text: "To listen on the watch, connect AirPods to it in Control Centre.")) }
        if let p = player.problem, p != "noairpods" { out.append(Line(id: 4, ok: false, text: Words.why(p))) }
        let v = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0") + " (" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1") + ")"
        out.append(Line(id: 5, ok: nil, text: "Watch " + v + (store.snap.map { $0.build.isEmpty ? "" : " · iPhone " + String($0.build.prefix(7)) } ?? "")))
        return out
    }

    private func sync() async {
        syncing = true
        store.hello()
        let r = await store.send("snap")
        if r.ok, let s = r.snap { store.receive(s); Haptic.success() } else { Haptic.warn() }
        syncing = false
    }
}

/// Before the first snapshot: Shelf's mark and one plain line
struct FirstLaunch: View {
    var body: some View {
        VStack(spacing: 6) {
            Spacer(minLength: 0)
            VStack(spacing: 3) {
                Rectangle().fill(Color(hex: 0xffe41a)).frame(width: 48, height: 10)
                Rectangle().fill(Color(hex: 0x1a35d6)).frame(width: 48, height: 10)
                Rectangle().fill(Ink.dim).frame(width: 48, height: 10)
            }
            .padding(.bottom, 6)
            Text("Open Shelf on your iPhone").font(.shelf(15, .heavy)).foregroundStyle(Ink.ink).multilineTextAlignment(.center)
            Text("Your shelf comes over by itself in a few seconds.").font(.shelf(14, .regular)).foregroundStyle(Ink.grey).multilineTextAlignment(.center)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metric.inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
    }
}
