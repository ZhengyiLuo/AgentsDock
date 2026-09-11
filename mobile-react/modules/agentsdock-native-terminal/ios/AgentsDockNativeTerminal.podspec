require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'AgentsDockNativeTerminal'
  s.version          = package['version']
  s.summary          = 'Native SwiftTerm terminal view for AgentsDock.'
  s.description      = 'Bridges a persistent AgentsDock tmux websocket into a native iOS terminal.'
  s.license          = package['license']
  s.author           = 'AgentsDock'
  s.homepage         = 'https://github.com/ZhengyiLuo/ZenithDock'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.resources = 'Vendor/SwiftTerm/Apple/Metal/Shaders.metal'
  s.exclude_files = 'Vendor/SwiftTerm/Mac/**/*'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
