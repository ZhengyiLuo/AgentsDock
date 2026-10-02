import assert from 'node:assert/strict'
import { isImageUpload, isVideoUpload, mediaAssetsToUploads, photoAssetsToUploads } from './uploads'

const uploads = mediaAssetsToUploads([
  { uri: 'file:///picker/IMG_0042.HEIC', fileName: 'Vacation.heic', mimeType: 'image/heic', fileSize: 4_200_000 },
  { uri: 'file:///picker/render', mimeType: 'image/png' },
  { uri: 'file:///picker/no-name.webp?token=local' },
  { uri: 'file:///picker/export', fileName: 'Clip', mimeType: 'video/quicktime', fileSize: 8_000_000, type: 'video' },
  { uri: 'file:///picker/rendered-video', mimeType: 'video/mp4' },
  { uri: 'file:///picker/legacy.M4V?token=local' },
  { uri: '   ' },
], 1234)

assert.equal(JSON.stringify(uploads), JSON.stringify([
  { uri: 'file:///picker/IMG_0042.HEIC', name: 'Vacation.heic', type: 'image/heic', size: 4_200_000 },
  { uri: 'file:///picker/render', name: 'photo-1234-2.png', type: 'image/png' },
  { uri: 'file:///picker/no-name.webp?token=local', name: 'photo-1234-3.webp', type: 'image/webp' },
  { uri: 'file:///picker/export', name: 'Clip.mov', type: 'video/quicktime', size: 8_000_000 },
  { uri: 'file:///picker/rendered-video', name: 'video-1234-5.mp4', type: 'video/mp4' },
  { uri: 'file:///picker/legacy.M4V?token=local', name: 'video-1234-6.m4v', type: 'video/x-m4v' },
]))

assert.deepEqual(photoAssetsToUploads([{ uri: 'file:///picker/movie.mov', type: 'video' }], 999), [
  { uri: 'file:///picker/movie.mov', name: 'video-999-1.mov', type: 'video/quicktime' },
])
assert.equal(isImageUpload({ uri: 'file:///picker/render', name: 'render', type: 'image/png' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/IMG_0042.HEIC', name: 'Vacation.heic' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/photo', name: 'photo.TIFF?ignored' }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/photo.webp?token=local', name: '', type: undefined }), true)
assert.equal(isImageUpload({ uri: 'file:///picker/report.pdf', name: 'report.pdf', type: 'application/pdf' }), false)
assert.equal(isImageUpload({ uri: 'file:///picker/movie.mov', name: 'movie.mov', type: 'video/quicktime' }), false)
assert.equal(isVideoUpload({ uri: 'file:///picker/movie.mov', name: 'movie.mov', type: 'video/quicktime' }), true)
assert.equal(isVideoUpload({ uri: 'file:///picker/clip', name: 'clip.mp4' }), true)
assert.equal(isVideoUpload({ uri: 'file:///picker/photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }), false)

console.log('media upload mapping regressions passed')
