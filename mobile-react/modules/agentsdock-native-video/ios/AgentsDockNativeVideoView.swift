import AVFoundation
import ExpoModulesCore
import Foundation
import UIKit

public final class AgentsDockNativeVideoView: ExpoView, UIScrollViewDelegate {
  private let videoScrollView = UIScrollView()
  private let videoContentView = UIView()
  private let playerLayer = AVPlayerLayer()
  private let controlsView = UIView()
  private let playPauseButton = UIButton(type: .system)
  private let timelineSlider = UISlider()
  private let currentTimeLabel = UILabel()
  private let durationLabel = UILabel()
  private let zoomControlsView = UIView()
  private let zoomOutButton = UIButton(type: .system)
  private let zoomResetButton = UIButton(type: .system)
  private let zoomInButton = UIButton(type: .system)
  private let onStatus = EventDispatcher()
  private var itemStatusObservation: NSKeyValueObservation?
  private var timeControlObservation: NSKeyValueObservation?
  private var failedObserver: NSObjectProtocol?
  private var stalledObserver: NSObjectProtocol?
  private var endedObserver: NSObjectProtocol?
  private var periodicTimeObserver: Any?
  private var sourceURI: String?
  private var autoplay = true
  private var generation = 0
  private var ready = false
  private var emittedStatus: String?
  private var durationSeconds = 0.0
  private var scrubbing = false
  private var resumeAfterScrub = false
  private var videoViewportSize = CGSize.zero
  private let zoomSteps: [CGFloat] = [1, 1.5, 2, 3, 4]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .black
    clipsToBounds = true

    videoScrollView.backgroundColor = .black
    videoScrollView.minimumZoomScale = 1
    videoScrollView.maximumZoomScale = 4
    videoScrollView.bounces = false
    videoScrollView.bouncesZoom = true
    videoScrollView.alwaysBounceHorizontal = false
    videoScrollView.alwaysBounceVertical = false
    videoScrollView.showsHorizontalScrollIndicator = false
    videoScrollView.showsVerticalScrollIndicator = false
    videoScrollView.contentInsetAdjustmentBehavior = .never
    videoScrollView.decelerationRate = .fast
    videoScrollView.delaysContentTouches = false
    videoScrollView.delegate = self
    videoScrollView.accessibilityIdentifier = "agentsdock-video-zoom-surface"
    addSubview(videoScrollView)

    videoContentView.backgroundColor = .black
    videoContentView.isUserInteractionEnabled = false
    videoScrollView.addSubview(videoContentView)
    playerLayer.backgroundColor = UIColor.black.cgColor
    playerLayer.videoGravity = .resizeAspect
    videoContentView.layer.addSublayer(playerLayer)

    controlsView.backgroundColor = UIColor.black.withAlphaComponent(0.78)
    controlsView.layer.cornerRadius = 13
    controlsView.layer.cornerCurve = .continuous
    controlsView.clipsToBounds = true
    addSubview(controlsView)

    playPauseButton.tintColor = .white
    playPauseButton.accessibilityLabel = "Play video"
    playPauseButton.accessibilityIdentifier = "agentsdock-video-play-pause"
    playPauseButton.addTarget(self, action: #selector(togglePlayback), for: .touchUpInside)
    controlsView.addSubview(playPauseButton)

    timelineSlider.minimumValue = 0
    timelineSlider.maximumValue = 1
    timelineSlider.minimumTrackTintColor = .white
    timelineSlider.maximumTrackTintColor = UIColor.white.withAlphaComponent(0.34)
    timelineSlider.thumbTintColor = .white
    timelineSlider.isEnabled = false
    timelineSlider.accessibilityLabel = "Video timeline"
    timelineSlider.accessibilityIdentifier = "agentsdock-video-timeline"
    timelineSlider.addTarget(self, action: #selector(beginScrubbing), for: .touchDown)
    timelineSlider.addTarget(self, action: #selector(scrubValueChanged), for: .valueChanged)
    timelineSlider.addTarget(self, action: #selector(endScrubbing), for: [.touchUpInside, .touchUpOutside, .touchCancel])
    controlsView.addSubview(timelineSlider)

    configureTimeLabel(currentTimeLabel, value: "0:00")
    configureTimeLabel(durationLabel, value: "--:--")
    controlsView.addSubview(currentTimeLabel)
    controlsView.addSubview(durationLabel)
    updatePlaybackButton(isPlaying: false)

    zoomControlsView.backgroundColor = UIColor.black.withAlphaComponent(0.78)
    zoomControlsView.layer.cornerRadius = 13
    zoomControlsView.layer.cornerCurve = .continuous
    zoomControlsView.clipsToBounds = true
    addSubview(zoomControlsView)

    configureZoomButton(
      zoomOutButton,
      symbolName: "minus.magnifyingglass",
      accessibilityLabel: "Zoom video out",
      accessibilityIdentifier: "agentsdock-video-zoom-out",
      action: #selector(zoomOut)
    )
    configureZoomButton(
      zoomInButton,
      symbolName: "plus.magnifyingglass",
      accessibilityLabel: "Zoom video in",
      accessibilityIdentifier: "agentsdock-video-zoom-in",
      action: #selector(zoomIn)
    )
    zoomResetButton.tintColor = .white
    zoomResetButton.setTitleColor(.white, for: .normal)
    zoomResetButton.titleLabel?.font = .monospacedDigitSystemFont(ofSize: 11, weight: .bold)
    zoomResetButton.accessibilityLabel = "Reset video zoom"
    zoomResetButton.accessibilityIdentifier = "agentsdock-video-zoom-reset"
    zoomResetButton.addTarget(self, action: #selector(resetZoomFromControl), for: .touchUpInside)
    zoomControlsView.addSubview(zoomOutButton)
    zoomControlsView.addSubview(zoomResetButton)
    zoomControlsView.addSubview(zoomInButton)
    updateZoomControls(scale: 1)

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationWillResignActive),
      name: UIApplication.willResignActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    clearPlayer()
  }

  public override var bounds: CGRect {
    didSet {
      setNeedsLayout()
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    videoScrollView.frame = bounds
    if videoViewportSize != bounds.size {
      videoViewportSize = bounds.size
      resetZoom(animated: false)
      videoContentView.frame = CGRect(origin: .zero, size: bounds.size)
      videoScrollView.contentSize = bounds.size
      updateZoomControls(scale: 1)
    }
    playerLayer.frame = videoContentView.bounds

    let horizontalInset: CGFloat = 14
    let controlsHeight: CGFloat = 58
    let bottomInset: CGFloat = 14
    let availableWidth = max(0, bounds.width - horizontalInset * 2)
    controlsView.frame = CGRect(
      x: horizontalInset,
      y: max(0, bounds.height - controlsHeight - bottomInset),
      width: availableWidth,
      height: controlsHeight
    )

    let sideInset: CGFloat = 8
    let buttonWidth: CGFloat = 44
    let labelWidth: CGFloat = 44
    let gap: CGFloat = 5
    let centerY = controlsHeight / 2
    playPauseButton.frame = CGRect(x: sideInset, y: centerY - 22, width: buttonWidth, height: 44)
    currentTimeLabel.frame = CGRect(x: sideInset + buttonWidth + gap, y: centerY - 12, width: labelWidth, height: 24)
    durationLabel.frame = CGRect(x: max(sideInset, availableWidth - sideInset - labelWidth), y: centerY - 12, width: labelWidth, height: 24)
    let sliderX = currentTimeLabel.frame.maxX + gap
    timelineSlider.frame = CGRect(
      x: sliderX,
      y: centerY - 22,
      width: max(0, durationLabel.frame.minX - gap - sliderX),
      height: 44
    )

    let zoomButtonWidth: CGFloat = 42
    let zoomResetWidth: CGFloat = 48
    let zoomWidth = zoomButtonWidth * 2 + zoomResetWidth
    zoomControlsView.isHidden = bounds.width < zoomWidth + 28
    zoomControlsView.frame = CGRect(
      x: max(14, bounds.width - zoomWidth - 14),
      y: 14,
      width: min(zoomWidth, max(0, bounds.width - 28)),
      height: 44
    )
    zoomOutButton.frame = CGRect(x: 0, y: 0, width: zoomButtonWidth, height: 44)
    zoomResetButton.frame = CGRect(x: zoomButtonWidth, y: 0, width: zoomResetWidth, height: 44)
    zoomInButton.frame = CGRect(x: zoomButtonWidth + zoomResetWidth, y: 0, width: zoomButtonWidth, height: 44)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      resetZoom(animated: false)
      _ = pause()
    } else if autoplay && ready {
      _ = play()
    }
  }

  public func setAutoplay(_ value: Bool) {
    autoplay = value
    if value && ready && window != nil {
      _ = play()
    }
  }

  public func setSourceURI(_ value: String) {
    guard value != sourceURI else { return }
    sourceURI = value
    generation += 1
    let currentGeneration = generation
    resetZoom(animated: false)
    clearPlayer()
    ready = false
    emittedStatus = nil
    durationSeconds = 0
    updateTimeline(currentSeconds: 0)
    emitStatus("Loading")

    guard let url = URL(string: value), url.isFileURL else {
      emitStatus("Error", message: "The video source must be a local file.")
      return
    }
    let path = url.standardizedFileURL.path
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
          !isDirectory.boolValue,
          FileManager.default.isReadableFile(atPath: path) else {
      emitStatus("Error", message: "The prepared video file is unavailable.")
      return
    }

    let asset = AVURLAsset(url: url.standardizedFileURL)
    let item = AVPlayerItem(asset: asset)
    let player = AVPlayer(playerItem: item)
    player.allowsExternalPlayback = false
    player.automaticallyWaitsToMinimizeStalling = true
    player.preventsDisplaySleepDuringVideoPlayback = true
    playerLayer.player = player

    itemStatusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
      DispatchQueue.main.async {
        guard let self, let item, self.generation == currentGeneration,
              self.playerLayer.player?.currentItem === item else { return }
        switch item.status {
        case .readyToPlay:
          self.ready = true
          self.durationSeconds = Self.validSeconds(item.duration.seconds)
          self.timelineSlider.isEnabled = self.durationSeconds > 0
          self.timelineSlider.maximumValue = self.durationSeconds > 0 ? Float(self.durationSeconds) : 1
          self.updateTimeline(currentSeconds: Self.validSeconds(player.currentTime().seconds))
          self.installPeriodicTimeObserver(player: player, generation: currentGeneration)
          self.emitStatus("Ready", duration: self.durationSeconds > 0 ? self.durationSeconds : nil)
          if self.autoplay && self.window != nil {
            _ = self.play()
          }
        case .failed:
          self.ready = false
          self.emitStatus("Error", message: Self.playerErrorMessage(item.error))
        case .unknown:
          break
        @unknown default:
          self.emitStatus("Error", message: "The video player entered an unsupported state.")
        }
      }
    }

    timeControlObservation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self, weak player] _, _ in
      DispatchQueue.main.async {
        guard let self, let player, self.generation == currentGeneration,
              self.playerLayer.player === player else { return }
        let playing = player.timeControlStatus == .playing
        self.updatePlaybackButton(isPlaying: playing)
        guard self.ready else { return }
        switch player.timeControlStatus {
        case .playing:
          self.emitStatus("Playing")
        case .paused:
          self.emitStatus("Paused")
        case .waitingToPlayAtSpecifiedRate:
          break
        @unknown default:
          break
        }
      }
    }

    failedObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemFailedToPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self, weak item] notification in
      guard let self, let item, self.generation == currentGeneration,
            self.playerLayer.player?.currentItem === item else { return }
      let cause = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
      self.emitStatus("Error", message: Self.playerErrorMessage(cause ?? item.error))
    }

    stalledObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemPlaybackStalled,
      object: item,
      queue: .main
    ) { [weak self, weak item] _ in
      guard let self, let item, self.generation == currentGeneration,
            self.playerLayer.player?.currentItem === item else { return }
      self.emitStatus("Error", message: "Video playback stopped responding.")
    }

    endedObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: item,
      queue: .main
    ) { [weak self, weak item] _ in
      guard let self, let item, self.generation == currentGeneration,
            self.playerLayer.player?.currentItem === item else { return }
      self.updatePlaybackButton(isPlaying: false)
      self.updateTimeline(currentSeconds: self.durationSeconds)
      self.emitStatus("Paused")
    }
  }

  @discardableResult
  public func play() -> Bool {
    guard ready, window != nil, let player = playerLayer.player else { return false }
    if durationSeconds > 0, Self.validSeconds(player.currentTime().seconds) >= durationSeconds - 0.05 {
      player.seek(to: .zero)
      updateTimeline(currentSeconds: 0)
    }
    player.play()
    return true
  }

  @discardableResult
  public func pause() -> Bool {
    guard let player = playerLayer.player else { return false }
    player.pause()
    return true
  }

  public func viewForZooming(in scrollView: UIScrollView) -> UIView? {
    scrollView === videoScrollView ? videoContentView : nil
  }

  public func scrollViewDidEndZooming(
    _ scrollView: UIScrollView,
    with view: UIView?,
    atScale scale: CGFloat
  ) {
    guard scrollView === videoScrollView else { return }
    updateZoomControls(scale: scale)
  }

  public func scrollViewDidZoom(_ scrollView: UIScrollView) {
    guard scrollView === videoScrollView else { return }
    updateZoomControls(scale: scrollView.zoomScale)
  }

  public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    guard scrollView === videoScrollView else { return }
    updateZoomControls(scale: scrollView.zoomScale)
  }

  @objc private func togglePlayback() {
    guard let player = playerLayer.player else { return }
    if player.timeControlStatus == .playing {
      _ = pause()
    } else {
      _ = play()
    }
  }

  @objc private func zoomOut() {
    setZoomScale(adjacentZoomScale(direction: -1), animated: true)
  }

  @objc private func zoomIn() {
    setZoomScale(adjacentZoomScale(direction: 1), animated: true)
  }

  @objc private func resetZoomFromControl() {
    resetZoom(animated: true)
  }

  @objc private func beginScrubbing() {
    guard ready, let player = playerLayer.player else { return }
    scrubbing = true
    resumeAfterScrub = player.timeControlStatus == .playing
    player.pause()
  }

  @objc private func scrubValueChanged() {
    let seconds = min(durationSeconds, max(0, Double(timelineSlider.value)))
    currentTimeLabel.text = Self.formattedTime(seconds)
    timelineSlider.accessibilityValue = "\(Self.formattedTime(seconds)) of \(Self.formattedTime(durationSeconds))"
    // VoiceOver adjusts UISlider through valueChanged without delivering the
    // touchDown/touchUp pair used by a finger drag. Seek immediately in that
    // path so the accessible timeline cannot move independently of playback.
    guard !scrubbing, ready, let player = playerLayer.player else { return }
    let shouldResume = player.timeControlStatus == .playing
    player.pause()
    seek(player: player, seconds: seconds, resume: shouldResume)
  }

  @objc private func endScrubbing() {
    guard scrubbing, let player = playerLayer.player else { return }
    scrubbing = false
    let shouldResume = resumeAfterScrub
    resumeAfterScrub = false
    let seconds = min(durationSeconds, max(0, Double(timelineSlider.value)))
    seek(player: player, seconds: seconds, resume: shouldResume)
  }

  private func seek(player: AVPlayer, seconds: Double, resume: Bool) {
    let target = CMTime(seconds: seconds, preferredTimescale: 600)
    player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak player] _ in
      DispatchQueue.main.async {
        guard let self, let player, self.playerLayer.player === player else { return }
        self.updateTimeline(currentSeconds: seconds)
        if resume && self.window != nil {
          player.play()
        }
      }
    }
  }

  @objc private func applicationWillResignActive() {
    _ = pause()
  }

  private func configureTimeLabel(_ label: UILabel, value: String) {
    label.text = value
    label.textColor = .white
    label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
    label.textAlignment = .center
    label.adjustsFontSizeToFitWidth = true
    label.minimumScaleFactor = 0.8
    label.isAccessibilityElement = false
  }

  private func configureZoomButton(
    _ button: UIButton,
    symbolName: String,
    accessibilityLabel: String,
    accessibilityIdentifier: String,
    action: Selector
  ) {
    let configuration = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
    button.setImage(UIImage(systemName: symbolName, withConfiguration: configuration), for: .normal)
    button.tintColor = .white
    button.accessibilityLabel = accessibilityLabel
    button.accessibilityIdentifier = accessibilityIdentifier
    button.addTarget(self, action: action, for: .touchUpInside)
  }

  private func adjacentZoomScale(direction: Int) -> CGFloat {
    let current = videoScrollView.zoomScale
    if direction > 0 {
      return zoomSteps.first(where: { $0 > current + 0.02 }) ?? videoScrollView.maximumZoomScale
    }
    return zoomSteps.reversed().first(where: { $0 < current - 0.02 }) ?? videoScrollView.minimumZoomScale
  }

  private func setZoomScale(_ value: CGFloat, animated: Bool) {
    guard videoScrollView.bounds.width > 0, videoScrollView.bounds.height > 0 else { return }
    let bounded = min(videoScrollView.maximumZoomScale, max(videoScrollView.minimumZoomScale, value))
    videoScrollView.setZoomScale(bounded, animated: animated)
    updateZoomControls(scale: bounded)
  }

  private func resetZoom(animated: Bool) {
    if !animated {
      // Source changes and rotation can arrive while a pinch is active. End
      // UIKit's recognizers before replacing player content so no stale
      // deceleration or transform callback can target the outgoing surface.
      videoScrollView.panGestureRecognizer.isEnabled = false
      videoScrollView.panGestureRecognizer.isEnabled = true
      videoScrollView.pinchGestureRecognizer?.isEnabled = false
      videoScrollView.pinchGestureRecognizer?.isEnabled = true
      videoScrollView.layer.removeAllAnimations()
      videoContentView.layer.removeAllAnimations()
    }
    setZoomScale(videoScrollView.minimumZoomScale, animated: animated)
    if !animated {
      videoScrollView.contentOffset = .zero
      videoScrollView.contentInset = .zero
    }
  }

  private func updateZoomControls(scale: CGFloat) {
    let bounded = min(videoScrollView.maximumZoomScale, max(videoScrollView.minimumZoomScale, scale))
    zoomOutButton.isEnabled = bounded > videoScrollView.minimumZoomScale + 0.02
    zoomInButton.isEnabled = bounded < videoScrollView.maximumZoomScale - 0.02
    zoomOutButton.alpha = zoomOutButton.isEnabled ? 1 : 0.34
    zoomInButton.alpha = zoomInButton.isEnabled ? 1 : 0.34
    let rounded = (bounded * 10).rounded() / 10
    let title = abs(rounded - rounded.rounded()) < 0.01
      ? "\(Int(rounded))×"
      : String(format: "%.1f×", rounded)
    if zoomResetButton.title(for: .normal) != title {
      zoomResetButton.setTitle(title, for: .normal)
    }
    zoomResetButton.accessibilityValue = title
  }

  private func updatePlaybackButton(isPlaying: Bool) {
    let symbolName = isPlaying ? "pause.fill" : "play.fill"
    let configuration = UIImage.SymbolConfiguration(pointSize: 17, weight: .bold)
    playPauseButton.setImage(UIImage(systemName: symbolName, withConfiguration: configuration), for: .normal)
    playPauseButton.accessibilityLabel = isPlaying ? "Pause video" : "Play video"
  }

  private func installPeriodicTimeObserver(player: AVPlayer, generation currentGeneration: Int) {
    removePeriodicTimeObserver()
    periodicTimeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.2, preferredTimescale: 600),
      queue: .main
    ) { [weak self, weak player] time in
      guard let self, let player, self.generation == currentGeneration,
            self.playerLayer.player === player, !self.scrubbing else { return }
      self.updateTimeline(currentSeconds: Self.validSeconds(time.seconds))
    }
  }

  private func removePeriodicTimeObserver() {
    guard let observer = periodicTimeObserver else { return }
    periodicTimeObserver = nil
    playerLayer.player?.removeTimeObserver(observer)
  }

  private func updateTimeline(currentSeconds: Double) {
    let current = durationSeconds > 0 ? min(durationSeconds, max(0, currentSeconds)) : max(0, currentSeconds)
    if !scrubbing {
      timelineSlider.value = Float(current)
    }
    currentTimeLabel.text = Self.formattedTime(current)
    durationLabel.text = durationSeconds > 0 ? Self.formattedTime(durationSeconds) : "--:--"
    timelineSlider.accessibilityValue = durationSeconds > 0
      ? "\(Self.formattedTime(current)) of \(Self.formattedTime(durationSeconds))"
      : Self.formattedTime(current)
  }

  private func clearPlayer() {
    removePeriodicTimeObserver()
    itemStatusObservation?.invalidate()
    itemStatusObservation = nil
    timeControlObservation?.invalidate()
    timeControlObservation = nil
    if let failedObserver {
      NotificationCenter.default.removeObserver(failedObserver)
      self.failedObserver = nil
    }
    if let stalledObserver {
      NotificationCenter.default.removeObserver(stalledObserver)
      self.stalledObserver = nil
    }
    if let endedObserver {
      NotificationCenter.default.removeObserver(endedObserver)
      self.endedObserver = nil
    }
    playerLayer.player?.pause()
    playerLayer.player?.replaceCurrentItem(with: nil)
    playerLayer.player = nil
    updatePlaybackButton(isPlaying: false)
    timelineSlider.isEnabled = false
  }

  private func emitStatus(_ status: String, message: String? = nil, duration: Double? = nil) {
    if message == nil && duration == nil && emittedStatus == status { return }
    emittedStatus = status
    var payload: [String: Any] = ["status": status]
    if let message, !message.isEmpty { payload["message"] = message }
    if let duration { payload["duration"] = duration }
    onStatus(payload)
  }

  private static func validSeconds(_ value: Double) -> Double {
    value.isFinite && value > 0 ? value : 0
  }

  private static func formattedTime(_ value: Double) -> String {
    let seconds = max(0, Int(value.rounded(.down)))
    let hours = seconds / 3600
    let minutes = (seconds % 3600) / 60
    let remainder = seconds % 60
    if hours > 0 {
      return String(format: "%d:%02d:%02d", hours, minutes, remainder)
    }
    return String(format: "%d:%02d", minutes, remainder)
  }

  private static func playerErrorMessage(_ error: Error?) -> String {
    let detail = error?.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return detail.isEmpty ? "Apple's video player could not open this file." : detail
  }
}
