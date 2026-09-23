#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// Local beta.11 was accepted as build 1185. Public preparation runs 1–20 reserve
// 1185 + run. After run 20 (1205), local 1.0.7-beta.4 and beta.5 were accepted as
// 1206 and 1207. Runs 21 onward skip those two reservations: 1187 + run.
// Historical reruns retain their reservations; publishing an existing sealed
// draft does not consume another native build. Never use a flat max() floor.
const LAST_ACCEPTED_BUILD = 1185
const LAST_RUN_BEFORE_LOCAL_BUILDS = 20
const LOCAL_BUILD_RESERVATIONS = 2
export function validateDesktopBuildNumber(requested, runNumber) {
  if (!/^[1-9]\d*$/.test(String(requested)) || !/^[1-9]\d*$/.test(String(runNumber))) throw new Error('An explicit positive native build number and workflow run number are required.')
  const build = Number(requested), run = Number(runNumber)
  const offset = LAST_ACCEPTED_BUILD + (run > LAST_RUN_BEFORE_LOCAL_BUILDS ? LOCAL_BUILD_RESERVATIONS : 0)
  if (!Number.isSafeInteger(build) || !Number.isSafeInteger(run) || run > Number.MAX_SAFE_INTEGER - offset) throw new Error('Native build number exceeds the supported range.')
  const floor = offset + run
  if (build !== floor) throw new Error(`Native build ${build} does not match its reservation; this prepare run requires exactly ${floor}.`)
  return String(build)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`build_number=${validateDesktopBuildNumber(process.argv[2], process.argv[3])}\n`) }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
