#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { newestBetaVersionFromAtom } from '../electron/src/main/updater-feed.mjs'

const version = newestBetaVersionFromAtom(readFileSync(0, 'utf8'))
if (version) process.stdout.write(`${version}\n`)
else {
  process.stderr.write('No compatible AgentsDock beta was found in the public release feed.\n')
  process.exitCode = 1
}
