import SwiftUI
#if os(macOS)
import AVFoundation
import AVKit
#else
import WebKit
#endif

struct InlineVideoView: View {
    let url: URL
    @State private var isLoaded = false
    @State private var autoplayOnLoad = false
    #if os(macOS)
    @State private var thumbnail: NSImage?
    @State private var thumbnailFailed = false
    #endif

    var body: some View {
        ZStack {
            if isLoaded {
                InlineVideoPlayerView(url: url, autoplay: autoplayOnLoad)
            } else {
                #if os(macOS)
                VideoPlaceholderView(
                    filename: url.lastPathComponent,
                    thumbnail: thumbnail,
                    thumbnailFailed: thumbnailFailed,
                    play: startInlinePlayback,
                    fullscreen: {
                        #if os(macOS)
                        VideoFullscreenPresenter.present(url: url)
                        #endif
                    }
                )
                #else
                VideoPlaceholderView(
                    filename: url.lastPathComponent,
                    play: startInlinePlayback,
                    fullscreen: {}
                )
                #endif
            }
            #if os(macOS)
            VStack {
                HStack {
                    Spacer()
                    VideoOverlayButton(title: "Open Player", systemImage: "play.rectangle") {
                        VideoFullscreenPresenter.present(url: url)
                    }
                }
                Spacer()
            }
            .padding(10)
            #endif
        }
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
            #if os(macOS)
            .task(id: url) {
                await loadThumbnail()
            }
            #endif
    }

    private func startInlinePlayback() {
        autoplayOnLoad = true
        isLoaded = true
    }

    #if os(macOS)
    private func loadThumbnail() async {
        thumbnail = nil
        thumbnailFailed = false
        let data = await InlineVideoThumbnailCache.shared.thumbnailData(for: url)
        guard let data else {
            thumbnailFailed = true
            return
        }
        thumbnail = NSImage(data: data)
        thumbnailFailed = thumbnail == nil
    }
    #endif
}

private struct VideoPlaceholderView: View {
    let filename: String
    #if os(macOS)
    let thumbnail: NSImage?
    let thumbnailFailed: Bool
    #endif
    let play: () -> Void
    let fullscreen: () -> Void

    var body: some View {
        ZStack {
            #if os(macOS)
            if let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                fallbackBackground
            }
            #else
            fallbackBackground
            #endif
            LinearGradient(
                colors: [.black.opacity(0.62), .clear, .black.opacity(0.42)],
                startPoint: .top,
                endPoint: .bottom
            )
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 46, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .shadow(radius: 4)
                Text(filename)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.84))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 420)
                HStack(spacing: 10) {
                    VideoOverlayButton(title: "Play", systemImage: "play.fill", action: play)
                    #if os(macOS)
                    VideoOverlayButton(title: "Open Player", systemImage: "play.rectangle", action: fullscreen)
                    #endif
                }
                Spacer()
            }
            .padding(16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture(perform: play)
    }

    private var fallbackBackground: some View {
        ZStack {
            LinearGradient(
                colors: [Color.black, Color(red: 0.08, green: 0.09, blue: 0.10)],
                startPoint: .top,
                endPoint: .bottom
            )
            Image(systemName: "film.stack")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white.opacity(0.55))
        }
    }
}

private struct VideoOverlayButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(.black.opacity(0.62), in: Capsule())
                .overlay(Capsule().stroke(.white.opacity(0.18)))
        }
        .buttonStyle(.plain)
        .help(title)
    }
}

#if os(macOS)
struct InlineVideoPlayerView: NSViewRepresentable {
    let url: URL
    let autoplay: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> AVPlayerView {
        let playerView = AVPlayerView()
        playerView.controlsStyle = .inline
        playerView.videoGravity = .resizeAspect
        playerView.showsFullScreenToggleButton = true
        return playerView
    }

    func updateNSView(_ playerView: AVPlayerView, context: Context) {
        if context.coordinator.loadedURL != url {
            context.coordinator.loadedURL = url
            context.coordinator.autoplayedURL = nil
            playerView.player?.pause()
            playerView.player = AVPlayer(url: videoSourceURL(url))
        }
        if autoplay && context.coordinator.autoplayedURL != url {
            context.coordinator.autoplayedURL = url
            playerView.player?.play()
        }
    }

    static func dismantleNSView(_ playerView: AVPlayerView, coordinator: Coordinator) {
        playerView.player?.pause()
        playerView.player = nil
    }
}
#elseif os(iOS)
struct InlineVideoPlayerView: UIViewRepresentable {
    let url: URL
    let autoplay: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        makeWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        load(url, autoplay: autoplay, into: webView, coordinator: context.coordinator)
    }
}
#endif

final class Coordinator {
    var loadedURL: URL?
    var loadedAutoplay = false
    var autoplayedURL: URL?
}

#if os(macOS)
@MainActor
enum VideoFullscreenPresenter {
    private static var windows: [NSWindow] = []

    static func present(url: URL) {
        let playerView = AVPlayerView()
        playerView.controlsStyle = .inline
        playerView.videoGravity = .resizeAspect
        playerView.showsFullScreenToggleButton = true
        playerView.player = AVPlayer(url: videoSourceURL(url))

        let controller = NSViewController()
        controller.view = playerView

        let window = NSWindow(contentViewController: controller)
        window.title = url.lastPathComponent
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.collectionBehavior = [.fullScreenPrimary]
        window.setContentSize(NSSize(width: 1100, height: 720))
        window.center()
        window.makeKeyAndOrderFront(nil)
        windows.append(window)

        playerView.player?.play()
    }
}

private actor InlineVideoThumbnailCache {
    static let shared = InlineVideoThumbnailCache()

    private var cached: [String: Data] = [:]
    private var order: [String] = []
    private var failed: Set<String> = []
    private let maxCached = 160

    func thumbnailData(for url: URL) async -> Data? {
        let key = url.absoluteString
        if let data = cached[key] {
            return data
        }
        if failed.contains(key) {
            return nil
        }
        do {
            let data = try await Task.detached(priority: .utility) {
                try makeInlineVideoThumbnailData(from: url)
            }.value
            cached[key] = data
            order.append(key)
            trimIfNeeded()
            return data
        } catch {
            failed.insert(key)
            return nil
        }
    }

    private func trimIfNeeded() {
        guard order.count > maxCached else { return }
        let overflow = order.count - maxCached
        let expired = order.prefix(overflow)
        for key in expired {
            cached.removeValue(forKey: key)
        }
        order.removeFirst(overflow)
    }
}

private func makeInlineVideoThumbnailData(from url: URL) throws -> Data {
    let asset = AVURLAsset(url: videoSourceURL(url))
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 960, height: 540)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
    let image = try generator.copyCGImage(at: CMTime(seconds: 0.2, preferredTimescale: 600), actualTime: nil)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return data
}
#else
@MainActor
private func makeWebView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.allowsInlineMediaPlayback = true
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.allowsBackForwardNavigationGestures = false
    webView.setValue(false, forKey: "drawsBackground")
    return webView
}

@MainActor
private func load(_ url: URL, autoplay: Bool, into webView: WKWebView, coordinator: Coordinator) {
    guard coordinator.loadedURL != url || coordinator.loadedAutoplay != autoplay else { return }
    coordinator.loadedURL = url
    coordinator.loadedAutoplay = autoplay
    webView.loadHTMLString(videoHTML(for: url, autoplay: autoplay), baseURL: url.deletingLastPathComponent())
}
#endif

private func videoHTML(for url: URL, autoplay: Bool = false) -> String {
    let src = escapeHTML(videoSourceURL(url).absoluteString)
    let autoplayAttribute = autoplay ? " autoplay" : ""
    let autoplayScript = autoplay ? """
      <script>
        window.addEventListener('load', () => {
          const video = document.querySelector('video');
          if (video) { video.play().catch(() => {}); }
        });
      </script>
    """ : ""
    return """
    <!doctype html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        html, body {
          margin: 0;
          width: 100%;
          height: 100%;
          background: #050505;
          overflow: hidden;
        }
        video {
          width: 100vw;
          height: 100vh;
          object-fit: contain;
          background: #050505;
        }
      </style>
    </head>
    <body>
      <video src="\(src)" controls playsinline preload="metadata"\(autoplayAttribute)></video>
      \(autoplayScript)
    </body>
    </html>
    """
}

private func videoSourceURL(_ url: URL) -> URL {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    var items = components?.queryItems ?? []
    items.append(URLQueryItem(name: "inline_video", value: "1"))
    components?.queryItems = items
    return components?.url ?? url
}

private func escapeHTML(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}
