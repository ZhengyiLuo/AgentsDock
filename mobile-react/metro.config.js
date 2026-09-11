const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const buildRoot = path.resolve(__dirname, 'build');
const escapedBuildRoot = buildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const existingBlockList = Array.isArray(config.resolver.blockList)
  ? config.resolver.blockList
  : [config.resolver.blockList].filter(Boolean);

// Generated archives and DerivedData live below mobile-react/build. They are not
// application inputs and can contain hundreds of thousands of files.
config.resolver.blockList = [
  ...existingBlockList,
  /^build(?:[\\/]|$)/,
  new RegExp(`^${escapedBuildRoot}(?:[\\\\/]|$)`),
];

module.exports = config;
