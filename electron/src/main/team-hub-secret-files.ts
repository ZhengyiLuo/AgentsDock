import { app, dialog } from 'electron'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

const MAX_SECRET_FILE_BYTES = 16 * 1024
const execFileAsync = promisify(execFile)
let temporaryCounter = 0

type BootstrapProofChooser = (expectedPath: string) => Promise<string | null>
type ManagedControlRunner = (file: string, args: string[], options: ExecFileOptions) => Promise<void>

const runManagedControl: ManagedControlRunner = async (file, args, options) => {
  await execFileAsync(file, args, options)
}

const chooseManagedBootstrapProof: BootstrapProofChooser = async expectedPath => {
  const result = await dialog.showOpenDialog({
    title: 'Start Teamspace on this Mac',
    buttonLabel: 'Start Teamspace',
    defaultPath: expectedPath,
    properties: ['openFile'],
    filters: [{ name: 'Teamspace setup', extensions: ['proof'] }]
  })
  return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]
}

export interface TeamHubSecretFiles {
  readSecret(label: string): Promise<string>
  readBootstrapProof(expectedServerIdentity: string): Promise<string>
  chooseSavePath(suggestedName: string): Promise<string | null>
  writeSecret(path: string, secret: string): string
}

export class NativeTeamHubSecretFiles implements TeamHubSecretFiles {
  private readonly homeDirectory: () => string
  private readonly bootstrapProofChooser: BootstrapProofChooser
  private readonly managedControlRunner: ManagedControlRunner

  constructor(options: {
    homeDirectory?: () => string
    bootstrapProofChooser?: BootstrapProofChooser
    managedControlRunner?: ManagedControlRunner
  } = {}) {
    this.homeDirectory = options.homeDirectory ?? (() => app.getPath('home'))
    this.bootstrapProofChooser = options.bootstrapProofChooser ?? chooseManagedBootstrapProof
    this.managedControlRunner = options.managedControlRunner ?? runManagedControl
  }

  async readSecret(label: string): Promise<string> {
    requireSupportedSecretFilePlatform()
    const result = await dialog.showOpenDialog({
      title: `Choose ${label} file`,
      buttonLabel: 'Use Secret File',
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt', 'token', 'proof'] }]
    })
    if (result.canceled || result.filePaths.length !== 1) throw cancelledError()
    return readSecureSecretFile(result.filePaths[0])
  }

  async readBootstrapProof(expectedServerIdentity: string): Promise<string> {
    requireSupportedSecretFilePlatform()
    const home = this.homeDirectory()
    const stateDir = realpathSync(join(home, '.agentsdock'))
    if (localManagedServerIdentity(stateDir) !== expectedServerIdentity) {
      throw new Error('Start Teamspace from the actual local managed-server profile, not a tunnel or remote profile.')
    }
    const releasesRoot = realpathSync(join(home, '.local', 'share', 'agents-server', 'releases'))
    const releaseRoot = realpathSync(join(home, '.local', 'share', 'agents-server', 'current'))
    if (!pathIsWithin(releaseRoot, releasesRoot)) {
      throw new Error('The active AgentsServer is not installed in the managed release directory.')
    }
    requireManagedDirectory(releasesRoot, 'managed releases directory')
    requireManagedDirectory(releaseRoot, 'active managed release')
    requireManagedDirectory(join(releaseRoot, '.venv'), 'managed Python environment')
    requireManagedDirectory(join(releaseRoot, '.venv', 'bin'), 'managed Python environment')
    const packagePath = join(releaseRoot, 'agentsdock_team_hub')
    requireManagedDirectory(packagePath, 'Teamspace runtime')
    requireManagedFile(join(packagePath, 'cli.py'), 'Teamspace control module')
    const python = join(releaseRoot, '.venv', 'bin', 'python')
    requireManagedExecutable(python)
    const dataDir = join(stateDir, 'team-hub')
    await this.managedControlRunner(python, [
      '-m', 'agentsdock_team_hub.cli', 'bootstrap-proof', '--data-dir', dataDir
    ], {
      cwd: releaseRoot,
      env: { HOME: home, PATH: '/usr/bin:/bin', PYTHONPATH: releaseRoot },
      timeout: 15_000,
      maxBuffer: 4 * 1024,
      windowsHide: true
    })
    const expectedPath = join(stateDir, 'team-hub', 'bootstrap-owner.proof')
    const selectedPath = await this.bootstrapProofChooser(expectedPath)
    if (!selectedPath) throw cancelledError()
    if (realpathSync(selectedPath) !== realpathSync(expectedPath)) {
      throw new Error('Choose the Teamspace setup file created by this local managed server.')
    }
    const proof = readSecureSecretFile(expectedPath)
    if (!/^bootstrap\.[A-Za-z0-9_-]{43}$/.test(proof)) {
      throw new Error('The local Teamspace setup file is invalid. Restart the server and try Start Teamspace again.')
    }
    return proof
  }

  async chooseSavePath(suggestedName: string): Promise<string | null> {
    requireSupportedSecretFilePlatform()
    const result = await dialog.showSaveDialog({
      title: 'Save one-time Team Hub secret',
      buttonLabel: 'Save Secret',
      defaultPath: join(app.getPath('downloads'), safeFileName(suggestedName)),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    return result.canceled || !result.filePath ? null : result.filePath
  }

  writeSecret(path: string, secret: string): string {
    return writeSecureSecretFile(path, secret)
  }
}

function pathIsWithin(path: string, parent: string): boolean {
  const child = relative(parent, path)
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

function requireManagedDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`The ${label} is not a trusted directory.`)
  requireManagedOwnership(info.uid, info.mode, label)
}

function requireManagedFile(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`The ${label} is not a trusted file.`)
  requireManagedOwnership(info.uid, info.mode, label)
}

function requireManagedExecutable(path: string): void {
  const resolved = realpathSync(path)
  const info = statSync(resolved)
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error('The managed AgentsServer Python runtime is not executable.')
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (currentUid !== null && info.uid !== currentUid && info.uid !== 0) {
    throw new Error('The managed AgentsServer Python runtime has an unexpected owner.')
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error('The managed AgentsServer Python runtime is writable by another user.')
  }
}

function requireManagedOwnership(uid: number, mode: number, label: string): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new Error(`The ${label} has an unexpected owner.`)
  }
  if ((mode & 0o022) !== 0) throw new Error(`The ${label} is writable by another user.`)
}

function localManagedServerIdentity(stateDir: string): string {
  let machine = ''
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machine = readFileSync(path, 'utf8').trim()
    } catch { /* macOS and some containers do not provide a machine-id file */ }
    if (machine) break
  }
  if (!machine) machine = hostname()
  return createHash('sha256').update(`${machine}|${stateDir}`).digest('hex').slice(0, 24)
}

export function readSecureSecretFile(path: string): string {
  requireSupportedSecretFilePlatform()
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The selected secret must be a regular file, not a link.')
  if (before.size < 1 || before.size > MAX_SECRET_FILE_BYTES) throw new Error('The selected Team Hub secret file has an invalid size.')
  if (before.nlink !== 1) throw new Error('The selected Team Hub secret file must not have hard links.')
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error('The selected Team Hub secret file must be owned by the current user.')
  }
  if ((before.mode & 0o777) !== 0o600) {
    throw new Error('The selected Team Hub secret file must be private (mode 0600).')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const after = fstatSync(descriptor)
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error('The selected Team Hub secret file changed while opening it.')
    }
    if (typeof process.getuid === 'function' && after.uid !== process.getuid()) {
      throw new Error('The selected Team Hub secret file must be owned by the current user.')
    }
    if ((after.mode & 0o777) !== 0o600) throw new Error('The selected Team Hub secret file must be private (mode 0600).')
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length < 1 || length > MAX_SECRET_FILE_BYTES) throw new Error('The selected Team Hub secret file has an invalid size.')
    const raw = buffer.subarray(0, length)
    if (![...raw].every(byte => byte === 0x0a || (byte >= 0x21 && byte <= 0x7e))) {
      throw new Error('The selected Team Hub secret is invalid.')
    }
    const value = raw.toString('ascii').replace(/\n$/, '')
    if (!value || /\n/.test(value)) throw new Error('The selected Team Hub secret is invalid.')
    return value
  } finally {
    closeSync(descriptor)
  }
}

export function writeSecureSecretFile(path: string, value: string): string {
  requireSupportedSecretFilePlatform()
  const secret = value.trim()
  if (!secret || Buffer.byteLength(secret) > MAX_SECRET_FILE_BYTES || /[\u0000\r\n]/.test(secret)) {
    throw new Error('Team Hub returned an invalid one-time secret.')
  }
  let existing: ReturnType<typeof lstatSync> | null = null
  try { existing = lstatSync(path) } catch { /* a new file is expected */ }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('The selected destination must be a regular file, not a link.')
  }
  const directory = dirname(path)
  const temporaryPath = join(directory, `.${basename(path)}.agentsdock-${process.pid}-${++temporaryCounter}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    fchmodSync(descriptor, 0o600)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0) {
      throw new Error('Could not create a private Team Hub secret file.')
    }
    writeFileSync(descriptor, `${secret}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, path)
    syncDirectory(directory)
    return safeFileName(basename(path))
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor)
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

function safeFileName(value: string): string {
  const name = basename(value).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 120)
  return name || 'agentsdock-team-hub-secret.txt'
}

function cancelledError(): Error {
  const error = new Error('Secret file selection was cancelled.')
  error.name = 'TeamHubSecretSelectionCancelledError'
  return error
}

function requireSupportedSecretFilePlatform(): void {
  if (process.platform === 'win32') {
    throw new Error('Private Team Hub secret-file handoff is not yet available on Windows.')
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDONLY)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}
