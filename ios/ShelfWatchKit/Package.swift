// swift-tools-version:5.9
// What the iPhone app and the Apple Watch app share: the shapes Shelf's page sends (dev/src/app.js, "Apple Watch"),
// the link keys, and the small rules both ends follow. Pure Foundation, so `swift test` runs on a Mac or on Linux.
// The fixtures in Tests are real messages recorded from the page by dev/test/e2e.mjs (block W).
import PackageDescription

let package = Package(
    name: "ShelfWatchKit",
    platforms: [.iOS(.v15), .watchOS(.v10), .macOS(.v13)],
    products: [
        .library(name: "ShelfWatchKit", targets: ["ShelfWatchKit"])
    ],
    targets: [
        .target(name: "ShelfWatchKit"),
        .testTarget(name: "ShelfWatchKitTests", dependencies: ["ShelfWatchKit"], resources: [.copy("Fixtures")])
    ]
)
