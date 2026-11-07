const { withGradleProperties } = require('expo/config-plugins')

const KEY = 'AsyncStorage_db_size_in_MB'
const VALUE = '64'

module.exports = function withAndroidAsyncStorageCapacity(config) {
  return withGradleProperties(config, next => {
    const existing = next.modResults.find(item => item.type === 'property' && item.key === KEY)
    if (existing) existing.value = VALUE
    else next.modResults.push({ type: 'property', key: KEY, value: VALUE })
    return next
  })
}
