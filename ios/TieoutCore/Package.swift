// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TieoutCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "TieoutCore", targets: ["TieoutCore"])
    ],
    targets: [
        .target(
            name: "TieoutCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "TieoutCoreTests",
            dependencies: ["TieoutCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
