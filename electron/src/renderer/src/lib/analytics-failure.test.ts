import { describe, expect, it } from 'vitest'
import { analyticsFailureCategory } from './analytics-failure'

describe('privacy-safe failure categories', () => {
  it.each([
    ['Linked file failed: 404', 'not_found'],
    ['Download failed (404 Not Found): private file', 'not_found'],
    ['Linked file failed: 403', 'authentication'],
    ['HTTP 401 private host', 'authentication'],
    ['Native file open failed: private filename', 'native_open'],
    ['Server profile switch superseded this operation.', 'scope_changed'],
    ['fetch failed: private URL', 'network'],
    ['Connection timed out', 'timeout'],
    ['Download failed (500)', 'download'],
    ['Server health check reported unavailable.', 'unavailable'],
    ['something secret', 'unknown']
  ])('classifies %s without copying error details', (input, expected) => {
    expect(analyticsFailureCategory(new Error(input))).toBe(expected)
  })
})
