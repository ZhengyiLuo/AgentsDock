const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withFinalizedMod } = require('expo/config-plugins')

function sanitizePrivacyInfo(privacyInfo) {
  return {
    ...privacyInfo,
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
  }
}

function loadExpoPlist() {
  const configPluginsDirectory = path.dirname(require.resolve('expo/config-plugins'))
  const plistModule = require(require.resolve('@expo/plist', { paths: [configPluginsDirectory] }))
  return plistModule.default ?? plistModule
}

module.exports = function withIosNoAnalyticsPrivacy(config) {
  return withFinalizedMod(config, ['ios', async next => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(next.modRequest.projectRoot)
    const privacyInfoPath = path.join(next.modRequest.platformProjectRoot, projectName, 'PrivacyInfo.xcprivacy')
    if (!fs.existsSync(privacyInfoPath)) {
      throw new Error(`Missing generated iOS privacy manifest: ${privacyInfoPath}`)
    }

    const plist = loadExpoPlist()
    const privacyInfo = plist.parse(fs.readFileSync(privacyInfoPath, 'utf8'))
    fs.writeFileSync(privacyInfoPath, plist.build(sanitizePrivacyInfo(privacyInfo)))
    return next
  }])
}

module.exports.sanitizePrivacyInfo = sanitizePrivacyInfo
module.exports.loadExpoPlist = loadExpoPlist
