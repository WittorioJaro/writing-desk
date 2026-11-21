// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WritingDesk",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "WritingDeskCore"),
        .executableTarget(name: "WritingDesk", dependencies: ["WritingDeskCore"]),
        .executableTarget(name: "WritingDeskChecks", dependencies: ["WritingDeskCore"]),
    ]
)
