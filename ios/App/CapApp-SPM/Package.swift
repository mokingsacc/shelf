// swift-tools-version: 5.9
import PackageDescription

// Plugins are vendored in ios/vendor so Xcode builds without npm. Regenerate with: node dev/vendor-ios.mjs (after npx cap sync)
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "CapacitorApp", path: "../../vendor/app"),
        .package(name: "CapacitorClipboard", path: "../../vendor/clipboard"),
        .package(name: "CapacitorPreferences", path: "../../vendor/preferences")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorClipboard", package: "CapacitorClipboard"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences")
            ]
        )
    ]
)
