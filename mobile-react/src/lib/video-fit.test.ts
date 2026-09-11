import { isVideoFilled, nextVideoContentFit } from './video-fit'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

assert(nextVideoContentFit('contain') === 'cover', 'Fill should switch the video to the supported cover mode')
assert(nextVideoContentFit('cover') === 'contain', 'Fit should restore the complete video')
assert(!isVideoFilled('contain'), 'Contain mode should keep gallery navigation available')
assert(isVideoFilled('cover'), 'Cover mode should report the live video as filled')

console.log('video fit regressions passed')
