const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins')

/**
 * AgentsDock connects to user-owned AgentsServer instances over LAN/Tailscale.
 * Android 9+ blocks those HTTP/WebSocket profiles unless the release manifest
 * opts in explicitly. Expo's debug manifest opts in, but release does not.
 */
module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, next => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(next.modResults)
    application.$['android:usesCleartextTraffic'] = 'true'
    return next
  })
}
