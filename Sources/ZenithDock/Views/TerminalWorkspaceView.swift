import AppKit
import SwiftUI
import ZenithCore

struct TerminalWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedPane: WorkspacePane
    @State private var confirmKill = false

    private var terminalText: String {
        store.terminalSnapshot?.text ?? ""
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if store.selectedSession == nil {
                EmptyStateView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TerminalScreenView(
                    text: terminalText,
                    isEnabled: store.terminalSnapshot?.exists == true,
                    onText: { text in
                        Task { await store.sendTerminalInput(text, enter: false, refresh: false) }
                    },
                    onKey: { key in
                        Task { await store.sendTerminalInput("", enter: false, key: key, refresh: false) }
                    },
                    onResize: { columns, rows in
                        Task { await store.resizeSelectedTerminal(columns: columns, rows: rows) }
                    }
                )
                .padding(14)
                .background(Color.black.opacity(0.88))
            }
        }
        .background(Theme.window)
        .task(id: store.selectedSessionID) {
            guard store.selectedSessionID != nil else { return }
            await store.openSelectedTerminal(showErrors: false)
            while !Task.isCancelled {
                await store.refreshSelectedTerminal(showErrors: false)
                try? await Task.sleep(nanoseconds: 750_000_000)
            }
        }
        .confirmationDialog("Kill tmux session?", isPresented: $confirmKill) {
            Button("Kill Terminal", role: .destructive) {
                Task { await store.killSelectedTerminal() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This kills the tmux session for the selected chat.")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.selectedSession?.title ?? "Terminal")
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.terminalSnapshot?.exists == true ? .green : .secondary)
                        .frame(width: 7, height: 7)
                    Text(statusLine)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(minWidth: 180, maxWidth: .infinity, alignment: .leading)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Picker("Pane", selection: $selectedPane) {
                        ForEach(WorkspacePane.allCases) { pane in
                            Label(pane.title, systemImage: pane.systemImage).tag(pane)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 156)

                    Button {
                        Task { await store.openSelectedTerminal() }
                    } label: {
                        Label(store.terminalSnapshot?.exists == true ? "Reconnect" : "Start tmux", systemImage: "terminal")
                    }
                    .labelStyle(.titleAndIcon)
                    .disabled(store.selectedSession == nil)
                    .help("Open or reconnect the per-chat tmux session")

                    Button {
                        Task { await store.sendTerminalInput("", enter: false, key: "C-c", refresh: false) }
                    } label: {
                        Label("Interrupt", systemImage: "stop.circle")
                    }
                    .labelStyle(.iconOnly)
                    .disabled(store.terminalSnapshot?.exists != true)
                    .help("Send Ctrl-C to the tmux pane")

                    Button {
                        Task { await store.refreshSelectedTerminal() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .labelStyle(.iconOnly)
                    .disabled(store.selectedSession == nil)

                    Button(role: .destructive) {
                        confirmKill = true
                    } label: {
                        Label("Kill", systemImage: "trash")
                    }
                    .labelStyle(.iconOnly)
                    .disabled(store.terminalSnapshot?.exists != true)
                }
                .controlSize(.small)
                .fixedSize(horizontal: true, vertical: true)
            }
            .frame(minWidth: 180, idealWidth: 430, maxWidth: 560, alignment: .trailing)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(minHeight: 68)
        .background(Theme.panel)
    }

    private var statusLine: String {
        guard let snapshot = store.terminalSnapshot else {
            return store.selectedSession == nil ? "No chat selected" : "Opening tmux"
        }
        guard snapshot.exists else {
            return "No tmux session"
        }
        var parts = [snapshot.name]
        if let size = terminalSize(snapshot) {
            parts.append(size)
        }
        if let cwd = snapshot.cwd, !cwd.isEmpty {
            parts.append(cwd)
        }
        if let command = snapshot.command, !command.isEmpty {
            parts.append(command)
        }
        return parts.joined(separator: " · ")
    }

    private func terminalSize(_ snapshot: ZTerminalSnapshot) -> String? {
        guard let columns = snapshot.columns, let rows = snapshot.rows else { return nil }
        return "\(columns)x\(rows)"
    }
}

private struct TerminalScreenView: NSViewRepresentable {
    var text: String
    var isEnabled: Bool
    var onText: (String) -> Void
    var onKey: (String) -> Void
    var onResize: (Int, Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let textView = TerminalTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.allowsUndo = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = true
        textView.backgroundColor = NSColor(calibratedWhite: 0.04, alpha: 1)
        textView.textColor = NSColor(calibratedWhite: 0.92, alpha: 1)
        textView.insertionPointColor = .systemGreen
        textView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 12, height: 12)
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(width: 10_000, height: CGFloat.greatestFiniteMagnitude)
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = true
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.onText = onText
        textView.onKey = onKey

        scrollView.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.scrollView = scrollView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }
        textView.onText = isEnabled ? onText : nil
        textView.onKey = isEnabled ? onKey : nil
        textView.placeholderText = isEnabled ? "" : "tmux is starting..."
        let nextText = text.isEmpty ? textView.placeholderText : text
        if textView.string != nextText {
            let shouldStick = context.coordinator.isNearBottom()
            textView.string = nextText
            textView.textColor = text.isEmpty ? NSColor.secondaryLabelColor : NSColor(calibratedWhite: 0.92, alpha: 1)
            if shouldStick {
                textView.scrollToEndOfDocument(nil)
            }
        }
        context.coordinator.reportSize(onResize: onResize)
    }

    @MainActor
    final class Coordinator: NSObject {
        weak var textView: TerminalTextView?
        weak var scrollView: NSScrollView?
        private var lastColumns = 0
        private var lastRows = 0
        private var pendingResize: Task<Void, Never>?

        func isNearBottom() -> Bool {
            guard let scrollView else { return true }
            let visible = scrollView.contentView.bounds
            let totalHeight = scrollView.documentView?.bounds.height ?? visible.height
            return totalHeight - visible.maxY < 80
        }

        func reportSize(onResize: @escaping (Int, Int) -> Void) {
            guard let scrollView, let textView, scrollView.contentView.bounds.width > 0 else { return }
            let font = textView.font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
            let charWidth = max(6.0, "M".size(withAttributes: [.font: font]).width)
            let lineHeight = max(12.0, font.boundingRectForFont.height + 2)
            let contentSize = scrollView.contentView.bounds.size
            let columns = max(40, min(240, Int((contentSize.width - 24) / charWidth)))
            let rows = max(10, min(100, Int((contentSize.height - 24) / lineHeight)))
            guard abs(columns - lastColumns) > 1 || abs(rows - lastRows) > 1 else { return }
            lastColumns = columns
            lastRows = rows
            pendingResize?.cancel()
            pendingResize = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { return }
                onResize(columns, rows)
            }
        }
    }
}

private final class TerminalTextView: NSTextView {
    var onText: ((String) -> Void)?
    var onKey: ((String) -> Void)?
    var placeholderText = ""

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(self)
        }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }

    override func paste(_ sender: Any?) {
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        onText?(text)
    }

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let charsIgnoringModifiers = event.charactersIgnoringModifiers ?? ""
        let lower = charsIgnoringModifiers.lowercased()

        if flags.contains(.command) {
            switch lower {
            case "c":
                copy(nil)
            case "v":
                paste(nil)
            case "a":
                selectAll(nil)
            default:
                super.keyDown(with: event)
            }
            return
        }

        if flags.contains(.control), lower.count == 1, let scalar = lower.unicodeScalars.first, scalar.value >= 97, scalar.value <= 122 {
            onKey?("C-\(String(lower).uppercased())")
            return
        }

        if let key = tmuxKey(for: event.keyCode) {
            onKey?(key)
            return
        }

        if let characters = event.characters, !characters.isEmpty {
            onText?(characters)
            return
        }

        super.keyDown(with: event)
    }

    private func tmuxKey(for keyCode: UInt16) -> String? {
        switch keyCode {
        case 36, 76: "Enter"
        case 48: "Tab"
        case 51: "BSpace"
        case 53: "Escape"
        case 115: "Home"
        case 119: "End"
        case 116: "PPage"
        case 121: "NPage"
        case 123: "Left"
        case 124: "Right"
        case 125: "Down"
        case 126: "Up"
        case 117: "DC"
        default: nil
        }
    }
}
