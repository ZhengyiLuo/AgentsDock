import SwiftUI
import WebKit

struct InlineVideoView: View {
    let url: URL

    var body: some View {
        InlineVideoWebView(url: url)
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
    }
}

#if os(macOS)
struct InlineVideoWebView: NSViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        makeWebView()
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        load(url, into: webView, coordinator: context.coordinator)
    }
}
#elseif os(iOS)
struct InlineVideoWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        makeWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        load(url, into: webView, coordinator: context.coordinator)
    }
}
#endif

final class Coordinator {
    var loadedURL: URL?
}

@MainActor
private func makeWebView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.mediaTypesRequiringUserActionForPlayback = []
#if os(iOS)
    configuration.allowsInlineMediaPlayback = true
#endif
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.allowsBackForwardNavigationGestures = false
    webView.setValue(false, forKey: "drawsBackground")
    return webView
}

@MainActor
private func load(_ url: URL, into webView: WKWebView, coordinator: Coordinator) {
    guard coordinator.loadedURL != url else { return }
    coordinator.loadedURL = url
    webView.loadHTMLString(videoHTML(for: url), baseURL: url.deletingLastPathComponent())
}

private func videoHTML(for url: URL) -> String {
    let src = escapeHTML(videoSourceURL(url).absoluteString)
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
      <video src="\(src)" controls playsinline preload="metadata"></video>
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
