import { describe, expect, it, vi } from 'vitest'
import {
  NativeFileSelectionGate,
  nativeFileDropTarget,
  nativeFilePasteTarget
} from './native-file-selection'

function nativeFile(name: string, size = 4, lastModified = 10, type = 'application/octet-stream'): File {
  return { name, size, type, lastModified } as File
}

describe('NativeFileSelectionGate', () => {
  it('issues one-use tickets only for trusted native selections', () => {
    const pathForFile = vi.fn((file: File) => `/tmp/${file.name}`)
    const gate = new NativeFileSelectionGate(pathForFile)
    const file = nativeFile('image.png')

    gate.authorize([file], false)
    expect(() => gate.consume(file)).toThrow('Choose this file again')

    gate.authorize([file], true)
    expect(gate.consume(file)).toBe('/tmp/image.png')
    expect(() => gate.consume(file)).toThrow('Choose this file again')
  })

  it('allows a second trusted drop of the same path without allowing replay', () => {
    const pathForFile = (file: File) => `/tmp/${file.name}`
    const gate = new NativeFileSelectionGate(pathForFile)
    const firstDrop = nativeFile('video.mp4', 12, 20, 'video/mp4')
    const secondDrop = nativeFile('video.mp4', 12, 20, 'video/mp4')

    gate.authorize([firstDrop], true)
    expect(gate.consume(firstDrop)).toBe('/tmp/video.mp4')
    expect(() => gate.consume(firstDrop)).toThrow('Choose this file again')

    gate.authorize([secondDrop], true)
    expect(gate.consume(secondDrop)).toBe('/tmp/video.mp4')
  })

  it('consumes a batch atomically when every native file has a ticket', () => {
    const gate = new NativeFileSelectionGate(file => `/tmp/${file.name}`)
    const image = nativeFile('photo.png', 4, 10, 'image/png')
    const video = nativeFile('movie.mp4', 4, 10, 'video/mp4')
    gate.authorize([image], true)

    expect(() => gate.consumeBatch([image, video])).toThrow('Choose this file again')
    expect(gate.consume(image)).toBe('/tmp/photo.png')

    gate.authorize([image, video], true)
    expect(gate.consumeBatch([image, video])).toEqual(['/tmp/photo.png', '/tmp/movie.mp4'])
  })

  it('matches file metadata, expires tickets, and bounds pending selections', () => {
    let now = 100
    const gate = new NativeFileSelectionGate(file => `/tmp/${file.name}`, {
      now: () => now,
      ttlMs: 10,
      maxTickets: 2
    })
    const first = nativeFile('first.png', 1)
    const second = nativeFile('second.mp4', 2)
    const third = nativeFile('third.txt', 3)

    gate.authorize([first, second, third], true)
    expect(gate.consume(first)).toBe('/tmp/first.png')
    expect(gate.consume(second)).toBe('/tmp/second.mp4')
    expect(() => gate.consume(third)).toThrow('Choose this file again')

    gate.authorize([first], true)
    expect(() => gate.consume(nativeFile('first.png', 99))).toThrow('Choose this file again')
    now += 10
    expect(() => gate.consume(first)).toThrow('Choose this file again')
  })

  it('leaves non-native clipboard files available for byte staging', () => {
    const gate = new NativeFileSelectionGate(() => '')
    const clipboardImage = nativeFile('pasted.png')

    gate.authorize([clipboardImage], true)
    expect(gate.consume(clipboardImage)).toBeNull()
  })

  it('accepts drops only on chat surfaces and pastes only inside the composer', () => {
    const chat = document.createElement('div')
    chat.className = 'chat-workspace'
    const composer = document.createElement('div')
    composer.className = 'composer'
    const textarea = document.createElement('textarea')
    const settings = document.createElement('div')
    settings.className = 'settings-dialog'
    chat.append(composer)
    composer.append(textarea)

    expect(nativeFileDropTarget({ composedPath: () => [textarea, composer, chat, document.body] })).toBe(true)
    expect(nativeFilePasteTarget({ composedPath: () => [textarea, composer, chat, document.body] })).toBe(true)
    expect(nativeFileDropTarget({ composedPath: () => [settings, document.body] })).toBe(false)
    expect(nativeFilePasteTarget({ composedPath: () => [settings, document.body] })).toBe(false)
  })
})
