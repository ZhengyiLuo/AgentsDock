// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ZenithDock",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(name: "ZenithCore", targets: ["ZenithCore"]),
        .executable(name: "ZenithDock", targets: ["ZenithDock"]),
        .executable(name: "ZenithDockIOS", targets: ["ZenithDockIOS"]),
        .executable(name: "ZenithGuardrails", targets: ["ZenithGuardrails"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.14.0")
    ],
    targets: [
        .target(
            name: "ZenithCore",
            path: "Sources/ZenithCore"
        ),
        .executableTarget(
            name: "ZenithDock",
            dependencies: ["ZenithCore"],
            path: "Sources/ZenithDock",
            linkerSettings: [
                .linkedFramework("AVKit")
            ]
        ),
        .executableTarget(
            name: "ZenithDockIOS",
            dependencies: [
                "ZenithCore",
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ],
            path: "Sources/ZenithDockIOS",
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .linkedFramework("AVKit")
            ]
        ),
        .executableTarget(
            name: "ZenithGuardrails",
            dependencies: ["ZenithCore"],
            path: "Tools/ZenithGuardrails"
        )
    ]
)
