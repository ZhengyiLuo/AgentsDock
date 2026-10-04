#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageCoordinatedRelease } from './stage_coordinated_release.mjs'

export function coordinatedInputs(environment) {
  const manifestPath = environment.AGENTSDOCK_COORDINATED_MANIFEST
  const signaturePath = environment.AGENTSDOCK_COORDINATED_SIGNATURE
  if (!manifestPath && !signaturePath) return null
  if (!manifestPath || !signaturePath) throw new Error('Provide both AGENTSDOCK_COORDINATED_MANIFEST and AGENTSDOCK_COORDINATED_SIGNATURE.')
  if (!isAbsolute(manifestPath) || !isAbsolute(signaturePath)) throw new Error('Coordinated release inputs must use absolute paths.')
  return { manifestPath, signaturePath }
}

export function prepareElectronCoordinatedConfig({ project, outputDirectory, environment = process.env, publicKey }) {
  const inputs = coordinatedInputs(environment)
  if (!inputs) return null
  const projectPath = realpathSync(project)
  const output = realpathSync(outputDirectory)
  const outputFromProject = relative(projectPath, output)
  if (!outputFromProject || (!outputFromProject.startsWith(`..${sep}`) && outputFromProject !== '..' && !isAbsolute(outputFromProject))) throw new Error('Coordinated metadata must be staged outside the source Electron project.')
  const stagedPackage = join(output, 'package.json')
  const metadata = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8'))
  const stagedResources = join(output, 'build', 'coordinated-release')
  writeFileSync(stagedPackage, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' })
  stageCoordinatedRelease({ packageJSON: stagedPackage, resourcesDirectory: stagedResources, appVersion: metadata.version, ...inputs, ...(publicKey ? { publicKey } : {}) })
  const staged = JSON.parse(readFileSync(stagedPackage, 'utf8'))
  const config = {
    ...staged.build,
    extraMetadata: { ...staged.build?.extraMetadata, agentsDock: { ...staged.build?.extraMetadata?.agentsDock, ...staged.agentsDock } },
    extraResources: staged.build.extraResources.map(item => typeof item === 'object' && item?.to === 'coordinated-release' ? { ...item, from: stagedResources } : item),
  }
  const configPath = join(output, 'electron-builder.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  return configPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [project, outputDirectory] = process.argv.slice(2)
    if (!project || !outputDirectory || process.argv.length !== 4) throw new Error('Usage: prepare_electron_coordinated_config.mjs ELECTRON_PROJECT EXISTING_STAGE_DIRECTORY')
    const result = prepareElectronCoordinatedConfig({ project, outputDirectory })
    if (result) process.stdout.write(`${result}\n`)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
