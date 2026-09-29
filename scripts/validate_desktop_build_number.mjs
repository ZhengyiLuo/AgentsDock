#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// Preserve every allocated public run, including failed runs and reruns. The
// September 2026 cutover audited public runs through 20 and local native packages
// through 1.0.7-beta.24/build 1232. Resume above that high-water mark, not the stale
// original 1185 + run sequence. See docs/DIRECT_RELEASES.md for reservation rules.
// Append an audited epoch for a future cutover; never change an existing mapping
// or use a flat max() that gives several workflow runs the same native build.
const BUILD_EPOCHS = [
  { afterRun: 0, highestBuild: 1185 },
  { afterRun: 20, highestBuild: 1232 },
]
export function validateDesktopBuildNumber(requested, runNumber) {
  if (!/^[1-9]\d*$/.test(String(requested)) || !/^[1-9]\d*$/.test(String(runNumber))) throw new Error('An explicit positive native build number and workflow run number are required.')
  const build = Number(requested), run = Number(runNumber)
  if (!Number.isSafeInteger(build) || !Number.isSafeInteger(run)) throw new Error('Native build number exceeds the supported range.')
  const epoch = BUILD_EPOCHS.findLast(({ afterRun }) => run > afterRun)
  const offset = run - epoch.afterRun
  if (offset > Number.MAX_SAFE_INTEGER - epoch.highestBuild) throw new Error('Native build number exceeds the supported range.')
  const reserved = epoch.highestBuild + offset
  if (build !== reserved) throw new Error(`Native build ${build} does not match its reservation; this prepare run requires exactly ${reserved}.`)
  return String(build)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`build_number=${validateDesktopBuildNumber(process.argv[2], process.argv[3])}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
