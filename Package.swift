// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WritingDesk",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "WritingDeskCore"),
        .target(name: "WritingDeskServerKit", dependencies: ["WritingDeskCore"],
                linkerSettings: [.linkedLibrary("sqlite3")]),
        .executableTarget(name: "WritingDeskServer", dependencies: ["WritingDeskServerKit"]),
        .executableTarget(name: "WritingDeskChecks", dependencies: ["WritingDeskCore", "WritingDeskServerKit"]),
    ]
)
