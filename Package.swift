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
        .executable(name: "ZenithDockIOS", targets: ["ZenithDockIOS"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.0.7")
    ],
    targets: [
        .target(
            name: "ZenithCore",
            path: "Sources/ZenithCore"
        ),
        .executableTarget(
            name: "ZenithDock",
            dependencies: [
                "ZenithCore",
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ],
            path: "Sources/ZenithDock",
            linkerSettings: [
                .linkedFramework("AVKit")
            ]
        ),
        .executableTarget(
            name: "ZenithDockIOS",
            dependencies: ["ZenithCore"],
            path: "Sources/ZenithDockIOS",
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .linkedFramework("AVKit")
            ]
        )
    ]
)
