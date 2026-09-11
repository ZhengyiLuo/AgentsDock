require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'AgentsDockNativeVideo'
  s.version          = package['version']
  s.summary          = 'AVPlayer-backed local video playback for AgentsDock.'
  s.description      = 'Displays staged local videos with app-owned UIKit controls without an Expo Video player lifecycle.'
  s.license          = package['license']
  s.author           = 'AgentsDock'
  s.homepage         = 'https://github.com/ZhengyiLuo/AgentsDock'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
