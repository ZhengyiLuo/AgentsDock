import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeTeamHubSecretFiles, readSecureSecretFile, writeSecureSecretFile } from './team-hub-secret-files'

const directories: string[] = []
const windows = process.platform === 'win32'

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'agentsdock-hub-secret-'))
  directories.push(value)
  return value
}

function managedFixture(home: string) {
  const release = join(home, '.local', 'share', 'agents-server', 'releases', '0.1.25-beta.2')
  const current = join(home, '.local', 'share', 'agents-server', 'current')
  const dataDir = join(home, '.agentsdock', 'team-hub')
  const python = join(release, '.venv', 'bin', 'python')
  mkdirSync(join(release, '.venv', 'bin'), { recursive: true })
  mkdirSync(join(release, 'agentsdock_team_hub'))
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(python, '#!/bin/sh\n')
  chmodSync(python, 0o700)
  writeFileSync(join(release, 'agentsdock_team_hub', 'cli.py'), '# managed Teamspace control\n')
  chmodSync(join(release, 'agentsdock_team_hub', 'cli.py'), 0o600)
  symlinkSync(release, current)
  return { release, dataDir, python, proofPath: join(dataDir, 'bootstrap-owner.proof') }
}

function managedIdentity(home: string): string {
  let machine = ''
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { machine = readFileSync(path, 'utf8').trim() } catch { /* expected on macOS */ }
    if (machine) break
  }
  return createHash('sha256')
    .update(`${machine || hostname()}|${realpathSync(join(home, '.agentsdock'))}`)
    .digest('hex')
    .slice(0, 24)
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

// The implementation deliberately refuses secret-file handoff on Windows until it
// has an equivalent set of Windows-native ownership and ACL guarantees. The
// fixtures below exercise POSIX filesystem semantics (modes, links, and managed
// runtime paths), so they must only run on the platforms that support them.
describe.skipIf(windows)('Team Hub one-time secret files', () => {
  it('reads the exact managed bootstrap proof only after explicit native approval', async () => {
    const home = directory()
    const { release, dataDir, python, proofPath } = managedFixture(home)
    const proof = `bootstrap.${'a'.repeat(43)}`
    let controlRuns = 0
    const managedControlRunner = async (file: string, args: string[]) => {
      controlRuns += 1
      expect(file).toBe(realpathSync(python))
      expect(args).toEqual([
        '-m', 'agentsdock_team_hub.cli', 'bootstrap-proof', '--data-dir', realpathSync(dataDir)
      ])
      writeFileSync(proofPath, `${proof}\n`)
      chmodSync(proofPath, 0o600)
    }
    const bootstrapProofChooser = async (expectedPath: string) => {
      expect(realpathSync(expectedPath)).toBe(realpathSync(proofPath))
      return proofPath
    }
    const files = new NativeTeamHubSecretFiles({
      homeDirectory: () => home,
      bootstrapProofChooser,
      managedControlRunner
    })
    const expectedIdentity = managedIdentity(home)

    await expect(files.readBootstrapProof(expectedIdentity)).resolves.toBe(proof)
    expect(controlRuns).toBe(1)
    const wrongHost = new NativeTeamHubSecretFiles({
      homeDirectory: () => home,
      bootstrapProofChooser,
      managedControlRunner
    })
    await expect(wrongHost.readBootstrapProof('different-server')).rejects.toThrow('actual local managed-server profile')
    expect(controlRuns).toBe(1)
    expect(realpathSync(join(release, 'agentsdock_team_hub'))).toBe(join(realpathSync(release), 'agentsdock_team_hub'))
  })

  it('rejects a different selected file and malformed managed proof', async () => {
    const home = directory()
    const { dataDir, proofPath } = managedFixture(home)
    const otherPath = join(dataDir, 'other.proof')
    writeFileSync(otherPath, `bootstrap.${'b'.repeat(43)}\n`)
    chmodSync(otherPath, 0o600)
    const expectedIdentity = managedIdentity(home)
    const managedControlRunner = async () => {
      writeFileSync(proofPath, 'not-a-bootstrap-proof\n')
      chmodSync(proofPath, 0o600)
    }
    const wrongSelection = new NativeTeamHubSecretFiles({
      homeDirectory: () => home,
      bootstrapProofChooser: async () => otherPath,
      managedControlRunner
    })
    await expect(wrongSelection.readBootstrapProof(expectedIdentity)).rejects.toThrow('created by this local managed server')
    const malformed = new NativeTeamHubSecretFiles({
      homeDirectory: () => home,
      bootstrapProofChooser: async () => proofPath,
      managedControlRunner
    })
    await expect(malformed.readBootstrapProof(expectedIdentity)).rejects.toThrow('setup file is invalid')
  })

  it('does not show the native approval or read a proof when managed renewal fails', async () => {
    const home = directory()
    managedFixture(home)
    const bootstrapProofChooser = async () => {
      throw new Error('approval must not open')
    }
    const files = new NativeTeamHubSecretFiles({
      homeDirectory: () => home,
      bootstrapProofChooser,
      managedControlRunner: async () => { throw new Error('Managed Teamspace renewal failed.') }
    })

    await expect(files.readBootstrapProof(managedIdentity(home))).rejects.toThrow('Managed Teamspace renewal failed.')
  })

  it('writes an atomic private file and reads its bounded single-line value', () => {
    const path = join(directory(), 'invite.txt')
    expect(writeSecureSecretFile(path, 'one-time-secret')).toBe('invite.txt')
    expect(readFileSync(path, 'utf8')).toBe('one-time-secret\n')
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(readSecureSecretFile(path)).toBe('one-time-secret')
  })

  it('rejects links, oversized files, multiline values, and non-private modes', () => {
    const root = directory()
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    writeFileSync(target, 'secret')
    chmodSync(target, 0o600)
    symlinkSync(target, link)
    expect(() => readSecureSecretFile(link)).toThrow('regular file')
    writeFileSync(target, 'line-one\nline-two')
    expect(() => readSecureSecretFile(target)).toThrow('invalid')
    writeFileSync(target, 'x'.repeat(16 * 1024 + 1))
    expect(() => readSecureSecretFile(target)).toThrow('invalid size')
    if (process.platform !== 'win32') {
      writeFileSync(target, 'secret')
      chmodSync(target, 0o644)
      expect(() => readSecureSecretFile(target)).toThrow('mode 0600')
    }
  })

  it('rejects hard links and non-ASCII token data', () => {
    const root = directory()
    const target = join(root, 'target.txt')
    const hardLink = join(root, 'hard-link.txt')
    writeFileSync(target, 'secret')
    chmodSync(target, 0o600)
    linkSync(target, hardLink)
    expect(() => readSecureSecretFile(target)).toThrow('hard links')
    rmSync(hardLink)
    writeFileSync(target, Buffer.from([0xff, 0xfe, 0xfd]))
    expect(() => readSecureSecretFile(target)).toThrow('invalid')
  })

  it('refuses to overwrite a symlink destination', () => {
    const root = directory()
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    writeFileSync(target, 'do-not-overwrite')
    symlinkSync(target, link)
    expect(() => writeSecureSecretFile(link, 'new-secret')).toThrow('regular file')
    expect(readFileSync(target, 'utf8')).toBe('do-not-overwrite')
  })
})

describe.runIf(windows)('Team Hub one-time secret files on Windows', () => {
  it('rejects every secret-file handoff entry point before touching the filesystem', async () => {
    const files = new NativeTeamHubSecretFiles()
    const unavailable = 'Private Team Hub secret-file handoff is not yet available on Windows.'

    expect(() => readSecureSecretFile('C:\\not-a-secret.txt')).toThrow(unavailable)
    expect(() => writeSecureSecretFile('C:\\not-a-secret.txt', 'one-time-secret')).toThrow(unavailable)
    expect(() => files.writeSecret('C:\\not-a-secret.txt', 'one-time-secret')).toThrow(unavailable)
    await expect(files.readSecret('Teamspace invitation')).rejects.toThrow(unavailable)
    await expect(files.readBootstrapProof('server-identity')).rejects.toThrow(unavailable)
    await expect(files.chooseSavePath('invite.txt')).rejects.toThrow(unavailable)
  })
})
