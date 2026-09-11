import { describe, expect, it } from 'vitest'
import {
  effectiveFileContentType,
  inferredFileContentType,
  internalFileViewerKind,
  isEditorTextFile,
  isInternalViewerFile,
  isPreviewableFile
} from './file-content-type'

describe('file content type normalization', () => {
  it('recovers a PNG sent as generic binary data', () => {
    const file = { filename: 'screen.PNG', content_type: 'application/octet-stream; charset=binary' }
    expect(effectiveFileContentType(file)).toBe('image/png')
    expect(isPreviewableFile(file)).toBe(true)
  })

  it('preserves a specific recorded content type', () => {
    expect(effectiveFileContentType({ filename: 'screen.png', content_type: 'image/custom' })).toBe('image/custom')
  })

  it('leaves unknown extensions as generic binary data', () => {
    expect(inferredFileContentType('archive.unknown')).toBe('application/octet-stream')
  })

  it('recognizes code and text artifacts even when the server records a generic type', () => {
    expect(isEditorTextFile({ filename: 'policy_runner.py', content_type: 'application/octet-stream' })).toBe(true)
    expect(isEditorTextFile({ filename: 'Dockerfile', content_type: null })).toBe(true)
    expect(isEditorTextFile({ filename: 'policy.yaml', content_type: 'application/yaml' })).toBe(true)
    expect(isEditorTextFile({ filename: '.gitignore', content_type: 'application/octet-stream' })).toBe(true)
    expect(isEditorTextFile({ filename: 'controls.proto', content_type: 'application/octet-stream' })).toBe(true)
    expect(isEditorTextFile({ filename: 'LICENSE-APACHE', content_type: 'application/octet-stream' })).toBe(true)
    expect(isEditorTextFile({ filename: 'archive.zip', content_type: 'application/octet-stream' })).toBe(false)
  })

  it('routes supported editor and preview formats without treating SVG as executable media', () => {
    expect(internalFileViewerKind({ filename: 'photo.webp', content_type: null })).toBe('image')
    expect(internalFileViewerKind({ filename: 'favicon.ico', content_type: null })).toBe('image')
    expect(internalFileViewerKind({ filename: 'paper.pdf', content_type: null })).toBe('pdf')
    expect(internalFileViewerKind({ filename: 'README.md', content_type: null })).toBe('markdown')
    expect(internalFileViewerKind({ filename: 'diagram.svg', content_type: 'image/svg+xml' })).toBe('text')
    expect(internalFileViewerKind({ filename: 'bundle.zip', content_type: null })).toBe('unsupported')
    expect(isInternalViewerFile({ filename: 'paper.pdf', content_type: null })).toBe(true)
    expect(isInternalViewerFile({ filename: 'bundle.zip', content_type: null })).toBe(false)
  })
})
