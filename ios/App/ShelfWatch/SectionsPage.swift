import SwiftUI
import ShelfWatchKit

/// Page 2, SECTIONS (design.md §3.2): one colour stripe per section, like the app icon
struct SectionsPage: View {
    @EnvironmentObject var store: Store
    @State private var all = false

    var body: some View {
        let list = store.snap?.sections ?? []
        let shown = all ? list : Array(list.prefix(5))
        ScrollView {
            VStack(spacing: 2) {
                ForEach(shown) { s in
                    let band = Band.of(section: s.id, in: store.snap)
                    Button { store.go(.section(s.id)) } label: {
                        HStack(spacing: 6) {
                            FitTitle(text: s.name, size: 18, color: band.fg)
                            Spacer(minLength: 0)
                            if s.newCount > 0 { NewTag(count: s.newCount, color: band.fg) } else {
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .heavy)).foregroundStyle(band.fg.opacity(0.6))
                            }
                        }
                        .padding(.horizontal, Metric.inset)
                        .frame(height: Metric.tap)
                        .background(band.bg)
                    }
                    .buttonStyle(Press())
                }
                if list.count > shown.count {
                    Button { all = true } label: { Cap(text: "+\(list.count - shown.count) more").frame(maxWidth: .infinity, minHeight: Metric.tap, alignment: .leading).padding(.horizontal, Metric.inset) }
                        .buttonStyle(Press())
                }
                if list.isEmpty {
                    Text("No sections yet. They come over from Shelf on your iPhone.").font(.shelf(14, .regular)).foregroundStyle(Ink.grey).padding(Metric.inset)
                }
            }
        }
        .page(.black)
    }
}

/// One video or episode: a 2-line title over its meta, and a progress bar when started
struct EntryRow: View {
    var e: Entry
    var band: Band
    var showSource = true
    var onBlack = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(e.course != nil ? (e.label.map { $0 + " · " } ?? "") + (e.short ?? e.title) : e.title)
                .font(.shelf(15, .bold)).lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(onBlack ? Ink.ink : band.fg)
            HStack(spacing: 4) {
                if e.isNew { Text("NEW").font(.shelf(10, .heavy)).foregroundStyle(onBlack ? Ink.ink : band.fg) }
                Meta(text: meta, color: (onBlack ? Ink.grey : band.fg.opacity(0.85)))
            }
            if e.started {
                ProgressLine(fraction: e.dur > 0 ? e.t / e.dur : 0, fill: onBlack ? Ink.ink : band.fg, track: (onBlack ? Ink.ink : band.fg).opacity(0.22)).padding(.top, 2)
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var meta: String {
        var bits: [String] = []
        if showSource, !e.srcName.isEmpty { bits.append(e.srcName) }
        if e.started { bits.append(Words.clock(e.t) + " / " + Words.clock(e.dur)) } else if e.done { bits.append("watched") } else if e.dur > 0 { bits.append(Words.clock(e.dur)) }
        return bits.joined(separator: " · ")
    }
}

/// A list that shows 5, then "+N more" adds 5 in place (design.md §6)
struct Rows<Item: Identifiable, Row: View>: View {
    var items: [Item]
    var total: Int? = nil                     // more exist than were sent (loaded by more())
    var color: Color
    var more: (() async -> Void)? = nil
    @ViewBuilder var row: (Item) -> Row
    @State private var shown = 5
    @State private var loading = false

    var body: some View {
        let list = Array(items.prefix(shown))
        let left = max(0, (total ?? items.count) - list.count)
        ForEach(Array(list.enumerated()), id: \.element.id) { i, it in
            if i > 0 { Rule(color: color, height: 2) }
            row(it)
        }
        if left > 0 {
            Rule(color: color, height: 2)
            Button {
                if shown + 5 > items.count, let more {
                    loading = true
                    Task { await more(); shown += 5; loading = false }
                } else { shown += 5 }
            } label: {
                Meta(text: loading ? "Loading from your iPhone…" : "+\(left) more", color: color)
                    .frame(maxWidth: .infinity, minHeight: Metric.tap, alignment: .leading)
            }
            .buttonStyle(Press())
        }
    }
}

/// A section (design.md §3.3), in its band's colours
struct SectionView: View {
    @EnvironmentObject var store: Store
    var id: String
    @State private var full: [Entry]?
    @State private var channelsOpen = false

    var body: some View {
        if let s = store.section(id) {
            let band = Band.of(section: id, in: store.snap)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    FitTitle(text: s.name, color: band.fg)
                    Meta(text: meta(s), color: band.fg.opacity(0.85)).padding(.bottom, 8)
                    Rule(color: band.fg)
                    if s.items.isEmpty && s.channels.isEmpty {
                        Text("No channels here yet. Add them in Shelf on your iPhone.").font(.shelf(14, .regular)).foregroundStyle(band.fg).padding(.vertical, 8)
                    }
                    Rows(items: full ?? s.items, total: (full?.count) ?? (s.items.count + s.more), color: band.fg, more: loader) { e in
                        Button { store.go(.playOn(e, band: id)) } label: { EntryRow(e: e, band: band) }.buttonStyle(Press())
                    }
                    if !s.channels.isEmpty { channels(s, band) }
                }
                .padding(.horizontal, Metric.inset)
            }
            .screen(band.bg)
            .onAppear { if s.newCount == 0 { channelsOpen = true } }
        } else {
            Text("This section is no longer in Shelf.").font(.shelf(14, .regular)).foregroundStyle(Ink.grey).screen(.black)
        }
    }

    private func meta(_ s: ShelfWatchKit.Section) -> String {
        var b: [String] = []
        if s.newCount > 0 { b.append("\(s.newCount) new") }
        if !s.channels.isEmpty { b.append("\(s.channels.count) channel" + (s.channels.count == 1 ? "" : "s")) }
        return b.isEmpty ? (s.id == "_pasted" ? "Links you pasted" : "Nothing new") : b.joined(separator: " · ")
    }

    private var loader: (() async -> Void)? {
        guard full == nil else { return nil }
        return { await load() }
    }

    private func load() async {
        let r = await store.send("section", ["id": id])
        if r.ok, let items = r.items { full = items }
    }

    @ViewBuilder private func channels(_ s: ShelfWatchKit.Section, _ band: Band) -> some View {
        Rule(color: band.fg, height: 2)
        Button { channelsOpen.toggle() } label: {
            HStack(spacing: 4) {
                Cap(text: "Channels · \(s.channels.count)", color: band.fg)
                Image(systemName: channelsOpen ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .heavy)).foregroundStyle(band.fg)
                Spacer(minLength: 0)
            }
            .frame(minHeight: Metric.tap)
        }
        .buttonStyle(Press())
        if channelsOpen {
            Rule(color: band.fg, height: 2)
            Rows(items: s.channels, color: band.fg) { c in
                Button { store.go(.channel(c, section: s.id)) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(c.name).font(.shelf(15, .bold)).lineLimit(1).foregroundStyle(band.fg)
                        Meta(text: (c.podcast ? "Podcast" : "YouTube") + (c.newCount > 0 ? " · \(c.newCount) new" : ""), color: band.fg.opacity(0.85))
                    }
                    .frame(maxWidth: .infinity, minHeight: Metric.tap, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(Press())
            }
        }
    }
}

/// A channel or podcast (design.md §3.4): its latest, loaded from the iPhone
struct ChannelView: View {
    @EnvironmentObject var store: Store
    var channel: Channel
    var section: String
    @State private var items: [Entry]?
    @State private var problem: String?

    var body: some View {
        let band = Band.of(section: section, in: store.snap)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FitTitle(text: channel.name, color: band.fg, minScale: 0.7)
                Meta(text: channel.podcast ? "Podcast" + (items.map { " · \($0.count) episodes" } ?? "") : "YouTube · latest", color: band.fg.opacity(0.85)).padding(.bottom, 8)
                Rule(color: band.fg)
                if let items {
                    if items.isEmpty { Text("Nothing here yet.").font(.shelf(14, .regular)).foregroundStyle(band.fg).padding(.vertical, 8) }
                    Rows(items: items, color: band.fg) { e in
                        Button { store.go(.playOn(e, band: section)) } label: { EntryRow(e: e, band: band, showSource: false) }.buttonStyle(Press())
                    }
                } else if let problem {
                    Text(problem).font(.shelf(14, .regular)).foregroundStyle(Ink.wait).padding(.vertical, 8).fixedSize(horizontal: false, vertical: true)
                    let cached = (store.section(section)?.items ?? []).filter { $0.src == channel.id }
                    ForEach(cached) { e in
                        Button { store.go(.playOn(e, band: section)) } label: { EntryRow(e: e, band: band, showSource: false) }.buttonStyle(Press())
                    }
                    if !store.stale.isEmpty { Meta(text: store.stale, color: band.fg.opacity(0.7)).padding(.top, 4) }
                } else {
                    Text("Loading from your iPhone…").font(.shelf(14, .regular)).foregroundStyle(band.fg).padding(.vertical, 8)
                }
            }
            .padding(.horizontal, Metric.inset)
        }
        .screen(band.bg)
        .task { await load() }
    }

    private func load() async {
        let r = await store.send("channel", ["id": channel.id])
        if r.ok, let it = r.items { items = Array(it.prefix(15)) } else { problem = r.why == "missing" ? r.problem : "Open Shelf on your iPhone to load this channel." }
    }
}
