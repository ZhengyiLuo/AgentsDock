#!/usr/bin/env node

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MIN_ELECTRON_MAIN_ENTRY_BYTES = 1024

function containedPath(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot !== '' && pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

export function verifyElectronCompileOutput(projectDirectory, options = {}) {
  const minimumBytes = options.minimumBytes ?? MIN_ELECTRON_MAIN_ENTRY_BYTES
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 1) {
    throw new Error('Electron compile output minimum must be a positive integer.')
  }

  const projectRoot = realpathSync(resolve(projectDirectory))
  const packagePath = resolve(projectRoot, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  const mainEntry = packageJson?.main
  if (typeof mainEntry !== 'string' || mainEntry.trim() === '' || isAbsolute(mainEntry)) {
    throw new Error('electron/package.json must declare a relative main entry.')
  }

  const declaredMainPath = resolve(projectRoot, mainEntry)
  if (!containedPath(projectRoot, declaredMainPath)) {
    throw new Error(`Electron main entry escapes its project directory: ${mainEntry}`)
  }

  const entryStat = lstatSync(declaredMainPath)
  if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
    throw new Error(`Electron main entry is not a regular file: ${mainEntry}`)
  }

  const realMainPath = realpathSync(declaredMainPath)
  if (!containedPath(projectRoot, realMainPath)) {
    throw new Error(`Electron main entry resolves outside its project directory: ${mainEntry}`)
  }
  if (entryStat.size < minimumBytes) {
    throw new Error(
      `Electron main entry ${mainEntry} is too small: ${entryStat.size} bytes ` +
      `(expected at least ${minimumBytes}).`
    )
  }

  return { mainPath: realMainPath, size: entryStat.size }
}

const scriptPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (scriptPath === import.meta.url) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const projectDirectory = process.argv[2] ? resolve(process.argv[2]) : resolve(repositoryRoot, 'electron')
  try {
    const result = verifyElectronCompileOutput(projectDirectory)
    console.log(`Verified Electron main entry: ${result.mainPath} (${result.size} bytes)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
