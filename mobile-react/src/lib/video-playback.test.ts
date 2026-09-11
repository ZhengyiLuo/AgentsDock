import {
  clampVideoTime,
  formatVideoTime,
  validVideoDuration,
  videoProgress,
  videoTimeAtPosition,
} from './video-playback'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(validVideoDuration(90) === 90, 'finite positive durations must remain available')
assert(validVideoDuration(0) === 0, 'zero duration must stay unavailable')
assert(validVideoDuration(Number.POSITIVE_INFINITY) === 0, 'live or invalid durations must stay unavailable')
assert(clampVideoTime(-5, 90) === 0, 'negative playback time must clamp to the start')
assert(clampVideoTime(120, 90) === 90, 'playback time must clamp to the duration')
assert(clampVideoTime(Number.NaN, 90) === 0, 'invalid playback time must clamp safely')
assert(videoTimeAtPosition(150, 300, 90) === 45, 'the middle of the timeline must seek to the middle of the video')
assert(videoTimeAtPosition(450, 300, 90) === 90, 'timeline positions beyond the track must clamp to the end')
assert(videoTimeAtPosition(10, 0, 90) === 0, 'an unmeasured timeline must not seek')
assert(videoProgress(45, 90) === 0.5, 'played progress must be normalized')
assert(videoProgress(100, 90) === 1, 'played progress must clamp to one')
assert(videoProgress(10, 0) === 0, 'unavailable durations must render zero progress')
assert(formatVideoTime(0) === '0:00', 'zero time must use minutes and seconds')
assert(formatVideoTime(65.9) === '1:05', 'sub-hour times must be floored and padded')
assert(formatVideoTime(3661) === '1:01:01', 'hour-long times must include hours')
assert(formatVideoTime(Number.NaN) === '0:00', 'invalid times must format safely')

console.log('video playback regressions passed')
