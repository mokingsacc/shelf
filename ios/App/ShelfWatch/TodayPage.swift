import SwiftUI
import ShelfWatchKit

/// Page 1, TODAY (design.md §3.1): what plays now, then the phone's Pick up rows
struct TodayPage: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var player: WatchPlayer

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    top(Act.showing(store, player, at: ctx.date))
                }
                ForEach(picks, id: \.id) { p in
                    PickRow(pick: p, big: picks.first?.id == p.id && Act.showing(store, player) == nil && store.live)
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .page(.black)
    }

    private var picks: [Pick] { Array((store.snap?.pick ?? []).prefix(3)) }

    @ViewBuilder private func top(_ s: Showing?) -> some View {
        if !store.live && !(s?.onWatch ?? false) {
            AwayBlock()
        } else if let s {
            NowBlock(s: s)
        } else {
            Cap(text: "Nothing playing").frame(height: 20, alignment: .leading)
        }
    }
}

/// The phone is away or Shelf isn't open: one plain line, and the time of the state shown (a tap opens CHECK)
struct AwayBlock: View {
    @EnvironmentObject var store: Store
    var body: some View {
        Button { store.tab = 4 } label: {
            HStack(alignment: .top, spacing: 6) {
                Rectangle().fill(Ink.wait).frame(width: 8, height: 8).padding(.top, 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Open Shelf on your iPhone to control it").font(.shelf(13, .bold)).foregroundStyle(Ink.ink).fixedSize(horizontal: false, vertical: true)
                    if !store.stale.isEmpty { Meta(text: store.stale) }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
        }
        .buttonStyle(Press())
    }
}

/// The NOW block: tag and title (a tap opens Now), play/pause on the right, progress along its foot
struct NowBlock: View {
    @EnvironmentObject var store: Store
    var s: Showing
    var body: some View {
        let pal = Palette.of(audio: !s.isVideo)
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { store.go(.now) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 3) {
                            Image(systemName: s.onWatch ? "applewatch" : "iphone").font(.system(size: 9, weight: .heavy))
                            Cap(text: (s.playing ? "" : "Paused · ") + s.tag, color: pal.night ? pal.mute : pal.accent)
                        }
                        .foregroundStyle(pal.night ? pal.mute : pal.accent)
                        Text(s.title).font(.shelf(15, .bold)).lineLimit(1).foregroundStyle(Ink.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(Press())
                PlayCell(s: s, pal: pal, size: 44)
            }
            .frame(height: 45)
            ProgressLine(fraction: s.dur > 0 ? s.t / s.dur : 0, fill: pal.accent).padding(.horizontal, -Metric.inset)
        }
        .padding(.bottom, 4)
    }
}

/// Play/pause as a square: playing is an accent fill; paused an accent outline (Night: a quiet outline)
struct PlayCell: View {
    var s: Showing
    var pal: Palette
    var size: CGFloat
    @State private var busy = false
    var body: some View {
        Button {
            busy = true
            Task { await Act.toggle(s); busy = false }
        } label: {
            ZStack {
                if pal.night {
                    Color.black
                    Rectangle().strokeBorder(pal.mute, lineWidth: 2).frame(width: size - 4, height: size - 4)
                    Image(systemName: s.playing ? "pause.fill" : "play.fill").font(.system(size: size * 0.41, weight: .bold)).foregroundStyle(pal.hi)
                } else if s.playing {
                    pal.accent
                    Image(systemName: "pause.fill").font(.system(size: size * 0.41, weight: .bold)).foregroundStyle(.black)
                } else {
                    Color.black
                    Rectangle().strokeBorder(pal.accent, lineWidth: 2)
                    Image(systemName: "play.fill").font(.system(size: size * 0.41, weight: .bold)).foregroundStyle(pal.accent)
                }
            }
            .frame(width: size, height: size)
            .opacity(busy ? 0.5 : 1)
        }
        .buttonStyle(Press())
        .accessibilityLabel(s.playing ? "Pause" : "Play")
    }
}

/// One Pick up row (Continue/Bedtime, Up next, Last in YouTube); a tap opens Play on
struct PickRow: View {
    @EnvironmentObject var store: Store
    var pick: Pick
    var big: Bool

    var body: some View {
        let e = pick.entry
        Button { store.go(.playOn(e, band: e.section)) } label: {
            VStack(alignment: .leading, spacing: 0) {
                Rule(color: Ink.hair, height: 2)
                if big { bigBody(e) } else { rowBody(e) }
            }
        }
        .buttonStyle(Press())
    }

    private var heading: String {
        switch pick.kind {
        case "upnext": return "Up next · " + (pick.label ?? "")
        default: return pick.heading + (pick.entry.srcName.isEmpty ? "" : " · " + pick.entry.srcName)
        }
    }

    private var title: String {
        let e = pick.entry
        if pick.kind == "upnext", let l = e.label { return l + " · " + (e.short ?? e.title) }
        return e.title
    }

    private var value: String {
        let e = pick.entry
        if pick.kind == "lastyt" { return e.t > 0 ? ((e.about == true ? "about " : "at ") + Words.clock(e.t)) : "" }
        if pick.kind == "upnext" { return e.dur > 0 ? Words.clock(e.dur) : "" }
        return ""
    }

    private func rowBody(_ e: Entry) -> some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Cap(text: heading)
                Text(title).font(.shelf(15, .bold)).lineLimit(1).foregroundStyle(Ink.ink)
            }
            Spacer(minLength: 0)
            if !value.isEmpty { Meta(text: value) }
        }
        .frame(height: 42)
    }

    private func bigBody(_ e: Entry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Cap(text: heading).padding(.top, 4)
            Text(title).font(.shelf(15, .heavy)).kerning(-0.2).lineLimit(2).foregroundStyle(Ink.ink).fixedSize(horizontal: false, vertical: true)
            Meta(text: [e.t > 5 ? Words.clock(e.t) : "", Words.left(e.t, e.dur)].filter { !$0.isEmpty }.joined(separator: " · "))
                .padding(.bottom, 5)
            ProgressLine(fraction: e.dur > 0 ? e.t / e.dur : 0, fill: Ink.blue, track: Ink.hair).padding(.horizontal, -Metric.inset)
        }
        .frame(minHeight: 72, alignment: .bottom)
    }
}
