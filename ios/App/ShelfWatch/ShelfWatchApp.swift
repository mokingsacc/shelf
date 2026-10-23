import SwiftUI
import ShelfWatchKit

// Shelf on the Apple Watch: the iPhone's Shelf, controlled from the wrist, and its podcasts played here.
// Design: /mnt/project-files/areas/youtube-resume/watch/design.md; the link: ShelfWatchKit/Link.swift.
@main
struct ShelfWatchApp: App {
    @StateObject private var store = Store.shared
    @StateObject private var player = WatchPlayer.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(player)
                .preferredColorScheme(.dark)
                .tint(Ink.ink)
                .onAppear { store.start(); Demo.open(store) }
                .onChange(of: phase) { _, p in if p == .active { store.hello() } }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        if store.snap == nil {
            FirstLaunch()
        } else {
            NavigationStack(path: $store.path) {
                TabView(selection: $store.tab) {
                    TodayPage().tag(0)
                    SectionsPage().tag(1)
                    CoursesPage().tag(2)
                    Step2Page().tag(3)
                    CheckPage().tag(4)
                }
                .tabViewStyle(.verticalPage)
                .navigationDestination(for: Route.self) { r in destination(r) }
            }
        }
    }

    @ViewBuilder private func destination(_ r: Route) -> some View {
        switch r {
        case .section(let id): SectionView(id: id)
        case .channel(let c, let s): ChannelView(channel: c, section: s)
        case .playOn(let e, let b): PlayOnView(entry: e, bandID: b)
        case .now: NowView()
        case .speed: SpeedView()
        case .sleep: SleepView()
        case .more: MoreView()
        case .notes(let k): NotesView(key: k)
        case .allCourses: AllCoursesView()
        case .course(let id): CourseView(id: id)
        case .check: CheckPage()
        }
    }
}
