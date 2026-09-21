#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// Local beta.11 was accepted as build 1185. The new public preparation workflow
// starts at run 1: reserve 1185 + run, without a flat max() range that could reuse
// build numbers after migrating from private CI. A rerun retains its reservation;
// publishing an existing sealed draft does not consume another native build.
const LAST_ACCEPTED_BUILD = 1185
export function validateDesktopBuildNumber(requested, runNumber) {
  if (!/^[1-9]\d*$/.test(String(requested)) || !/^[1-9]\d*$/.test(String(runNumber))) throw new Error('An explicit positive native build number and workflow run number are required.')
  const build = Number(requested), run = Number(runNumber)
  if (!Number.isSafeInteger(build) || !Number.isSafeInteger(run) || run > Number.MAX_SAFE_INTEGER - LAST_ACCEPTED_BUILD) throw new Error('Native build number exceeds the supported range.')
  const floor = LAST_ACCEPTED_BUILD + run
  if (build !== floor) throw new Error(`Native build ${build} does not match its reservation; this prepare run requires exactly ${floor}.`)
  return String(build)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`build_number=${validateDesktopBuildNumber(process.argv[2], process.argv[3])}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
