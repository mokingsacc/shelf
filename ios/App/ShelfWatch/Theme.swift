import SwiftUI
import ShelfWatchKit

// Shelf's look on the watch (design.md §1): the phone's dark-mode Day Sheet. Black, flat dark bands, heavy wide type,
// thick rules, tabular numbers, square corners. Always dark: nothing here is ever white or light grey.

extension Color {
    init(hex: UInt32, _ opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: opacity)
    }
}

enum Ink {
    static let bg = Color.black
    static let ink = Color(hex: 0xe6e6ef)
    static let grey = Color(hex: 0x8e8e9c)
    static let hair = Color(hex: 0x24242e)
    static let dim = Color(hex: 0x2a2a34)
    static let ok = Color(hex: 0x178a3a)
    static let wait = Color(hex: 0xd9a400)
    static let bad = Color(hex: 0xff6a52)
    static let blue = Color(hex: 0x5b74ff)
}

/// A section's band colours, as the phone gives them (Medicine yellow, Entertainment blue, the rest grey)
struct Band: Equatable {
    var bg: Color
    var fg: Color
    var grey: Bool          // on grey bands, anything that would be filled with fg is filled dim instead

    static let medicine = Band(bg: Color(hex: 0x1d1b08), fg: Color(hex: 0xf2de3c), grey: false)
    static let entertainment = Band(bg: Color(hex: 0x0e1445), fg: Color(hex: 0xb4c0ff), grey: false)
    static let other = Band(bg: Color(hex: 0x15151b), fg: Color(hex: 0xd8d8e2), grey: true)

    var fill: Color { grey ? Ink.dim : fg }
    var onFill: Color { grey ? Ink.ink : bg }

    static func of(section id: String, in snap: Snapshot?) -> Band {
        if id == "med" { return .medicine }
        if id == "ent" { return .entertainment }
        if id == "sleep" || id == "_pasted" || id.isEmpty { return .other }
        // Other sections take the colours in the phone's order: a 4th repeats yellow
        let order = (snap?.sections ?? []).filter { $0.id != "_pasted" }.map(\.id)
        if let i = order.firstIndex(of: id) { return [Band.entertainment, .medicine, .other][i % 3] }
        return .other
    }
}

/// The remote's palette: the phone's yellow player in the day, the night player for podcasts and late videos
struct Palette: Equatable {
    var accent: Color
    var mute: Color
    var text: Color
    var hi: Color
    var rule: Color
    var night: Bool

    static let player = Palette(accent: Color(hex: 0xffe41a), mute: Color(hex: 0x8d8d99), text: Ink.ink, hi: Ink.ink, rule: Ink.ink, night: false)
    static let nightly = Palette(accent: Color(hex: 0x5b74ff), mute: Color(hex: 0x8a8a98), text: Color(hex: 0xa3a3b0), hi: Color(hex: 0xd6d6e2), rule: Color(hex: 0x22222c), night: true)

    /// Podcasts always, and videos from 21:30 to 05:00
    static func of(audio: Bool, date: Date = Date()) -> Palette {
        if audio { return .nightly }
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        let m = (c.hour ?? 12) * 60 + (c.minute ?? 0)
        return m >= 21 * 60 + 30 || m < 5 * 60 ? .nightly : .player
    }
}

enum Metric {
    static let inset: CGFloat = 8
    static let tap: CGFloat = 44
    static let half: CGFloat = 83.5
    static let third: CGFloat = 54.3
    static let gap: CGFloat = 4
}

// MARK: Type

extension Font {
    static func shelf(_ size: CGFloat, _ weight: Font.Weight) -> Font { .system(size: size, weight: weight) }
}

/// Display (24 black) and Stripe (18 black): uppercase, one line, the width steps down to fit (the phone's fit())
struct FitTitle: View {
    var text: String
    var size: CGFloat = 24
    var color: Color = Ink.ink
    var minScale: CGFloat = 0.8

    var body: some View {
        let t = text.uppercased()
        let k: CGFloat = size >= 24 ? -0.8 : -0.6
        ViewThatFits(in: .horizontal) {
            line(t, k).fontWidth(.expanded)
            line(t, k)
            line(t, k).fontWidth(.condensed)
            line(t, k).fontWidth(.condensed).minimumScaleFactor(minScale)
        }
        .foregroundStyle(color)
    }

    private func line(_ t: String, _ k: CGFloat) -> some View {
        Text(t).font(.shelf(size, .black)).kerning(k).lineLimit(1).fixedSize(horizontal: false, vertical: true)
    }
}

/// Label: 11 heavy condensed uppercase, one line
struct Cap: View {
    var text: String
    var color: Color = Ink.grey
    var size: CGFloat = 11
    var body: some View {
        Text(text.uppercased()).font(.shelf(size, .heavy)).fontWidth(.condensed).kerning(0.6).lineLimit(1).truncationMode(.tail)
            .foregroundStyle(color).monospacedDigit()
    }
}

/// Meta: 12 medium, numbers tabular
struct Meta: View {
    var text: String
    var color: Color = Ink.grey
    var size: CGFloat = 12
    var weight: Font.Weight = .medium
    var lines: Int = 1
    var body: some View {
        Text(text).font(.shelf(size, weight)).monospacedDigit().lineLimit(lines).foregroundStyle(color)
    }
}

/// Button text: 13 black expanded uppercase
struct ButtonText: View {
    var text: String
    var color: Color
    var size: CGFloat = 13
    var body: some View {
        Text(text.uppercased()).font(.shelf(size, .black)).fontWidth(.expanded).kerning(0.4).lineLimit(1).minimumScaleFactor(0.7).foregroundStyle(color)
    }
}

/// The NEW tag: `NEW` or `3 NEW`, outlined
struct NewTag: View {
    var count: Int = 1
    var color: Color
    var body: some View {
        Text(count > 1 ? "\(count) NEW" : "NEW").font(.shelf(10, .heavy)).monospacedDigit().foregroundStyle(color)
            .padding(.vertical, 2).padding(.horizontal, 5)
            .overlay(Rectangle().stroke(color, lineWidth: 1.5))
    }
}

struct Rule: View {
    var color: Color = Ink.ink
    var height: CGFloat = 3
    var body: some View { Rectangle().fill(color).frame(height: height) }
}

/// A thin progress line (design: 3 or 4 pt)
struct ProgressLine: View {
    var fraction: Double
    var fill: Color
    var track: Color = Ink.dim
    var height: CGFloat = 3
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Rectangle().fill(track)
                Rectangle().fill(fill).frame(width: g.size.width * CGFloat(max(0, min(1, fraction.isFinite ? fraction : 0))))
            }
        }
        .frame(height: height)
    }
}

/// Pressed is 60% opacity, never a light flash
struct Press: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.contentShape(Rectangle()).opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// A square cell with a 2 pt outline (or a fill), for the remote's control row and the choice grids
struct Cell<Content: View>: View {
    var fill: Color = .black
    var outline: Color? = Ink.dim
    var width: CGFloat? = nil
    var height: CGFloat = Metric.tap
    @ViewBuilder var content: Content
    var body: some View {
        ZStack { fill; content }
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .overlay(Rectangle().strokeBorder(outline ?? .clear, lineWidth: 2))
    }
}

/// A 44 pt row with a grey label over an ink line, and an optional value on the right
struct LabelRow: View {
    var label: String
    var text: String
    var value: String = ""
    var labelColor: Color = Ink.grey
    var textColor: Color = Ink.ink
    var chevron = false
    var body: some View {
        HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                Cap(text: label, color: labelColor)
                Text(text).font(.shelf(15, .bold)).lineLimit(1).foregroundStyle(textColor)
            }
            Spacer(minLength: 0)
            if !value.isEmpty { Meta(text: value) }
            if chevron { Text("›").font(.shelf(17, .heavy)).foregroundStyle(labelColor) }
        }
        .frame(minHeight: Metric.tap)
        .contentShape(Rectangle())
    }
}

extension View {
    /// The screen's colour runs behind the clock into the bezel
    func page(_ color: Color) -> some View { containerBackground(color, for: .tabView) }
    func screen(_ color: Color) -> some View { containerBackground(color, for: .navigation) }
}
