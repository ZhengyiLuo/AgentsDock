#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const HELP = `Usage: agentsdock setup [--port PORT] [--bind IP] [--non-interactive] [--dry-run]
       agentsdock install [same options as setup]
       agentsdock servers [list | info NAME | new [--name NAME] [--port PORT] [--bind IP]]
       agentsdock servers start|stop|restart|remove NAME
       agentsdock token [--instance NAME]
       agentsdock status [--instance NAME]
       agentsdock update --server-url URL --server-identity ID --server-instance-id ID
         --token-file PATH --manifest PATH --signature PATH
       agentsdock recover
       agentsdock --version

setup/install creates a fresh default server. Use servers new for another instance.
servers remove asks for confirmation and preserves history by default.
token shows the existing token (default instance if omitted); keep it private.
update uses the signed managed updater; npm installation alone never upgrades a running server.
Install this command globally with npm install -g agentsdock, or use npx agentsdock.
`
const ROOT_SELECTORS = ['AGENTS_SERVER_INSTALL_DIR', 'AGENTS_SERVER_CONFIG_DIR',
  'AGENTS_SERVER_STATE_DIR', 'AGENTSDOCK_STATE_DIR', 'ZENITHBOT_AGENT_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'AGENTS_SERVER_INSTANCE']
const ENV_KEYS = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'TERM', 'TERMINFO', 'SSL_CERT_FILE', 'SSL_CERT_DIR']

function selector(args, fallback) {
  if (!args.length) return fallback
  if (args.length !== 2 || args[0] !== '--instance' || !/^[a-z][a-z0-9-]{0,31}$/.test(args[1])) {
    throw new Error('Use --instance NAME to select one server.')
  }
  return args[1]
}

function parse(argv) {
  const [command = '--help', ...args] = argv
  if (argv.some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('Invalid control character in arguments.')
  if (['help', '--help', '-h', '--version'].includes(command)) {
    if (args.length) throw new Error('Unexpected arguments.')
    return { kind: command === '--version' ? 'version' : 'help' }
  }
  if (['setup', 'install', 'update', 'recover'].includes(command)) {
    return { kind: 'core', args: [command === 'setup' ? 'install' : command, ...args] }
  }
  if (command === 'token') {
    return { kind: 'local', script: 'install.sh', args: ['--instance', selector(args, 'default'), '--show-token'] }
  }
  if (command === 'status') {
    const name = selector(args)
    return { kind: 'local', script: 'instances.sh', args: name ? ['info', name] : ['list'] }
  }
  if (['servers', 'instances'].includes(command)) {
    const [action = 'list', ...rest] = args
    // Internal binding helpers, manifests and the checkout-only update bypass
    // are not public npm commands. Python retains all instance/path validation.
    if (!['list', 'info', 'new', 'start', 'stop', 'restart', 'remove'].includes(action)) {
      throw new Error('Use servers list, info, new, start, stop, restart, or remove. Use agentsdock update for signed updates.')
    }
    return { kind: 'local', script: 'instances.sh', args: [action, ...rest] }
  }
  throw new Error('Unknown command. Run agentsdock --help.')
}

function readJson(filename) {
  const info = fs.lstatSync(filename)
  if (!info.isFile() || info.size > 64000) throw new Error('Invalid CLI package metadata.')
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function loadRuntime(packageRoot = __dirname, resolve = require.resolve) {
  const own = readJson(path.join(packageRoot, 'package.json'))
  const coreRoot = path.dirname(resolve('@agentsdock/server/package.json'))
  const core = readJson(path.join(coreRoot, 'package.json'))
  if (own.name !== 'agentsdock' || core.name !== '@agentsdock/server' ||
      own.dependencies?.['@agentsdock/server'] !== own.version || core.version !== own.version) {
    throw new Error('CLI and server package versions differ. Reinstall the matching agentsdock package.')
  }
  const payload = path.join(coreRoot, 'server')
  const versionFile = path.join(payload, 'VERSION')
  const info = fs.lstatSync(versionFile)
  if (!info.isFile() || info.size > 200 || fs.readFileSync(versionFile, 'utf8').trim() !== own.version) {
    throw new Error('CLI and server payload versions differ. Reinstall the matching agentsdock package.')
  }
  return { version: own.version, payload, run: require(path.join(coreRoot, 'npm/cli.cjs')).run }
}

function localEnvironment(context) {
  if (context.uid === 0) throw new Error('Run as the server owner, without sudo.')
  if (!['darwin', 'linux'].includes(context.platform)) throw new Error('Server management requires macOS or Linux.')
  for (const name of ROOT_SELECTORS) {
    if (context.env[name]) throw new Error(`Custom selector ${name} is unsupported; use --instance to select a managed server.`)
  }
  const env = { HOME: context.home }
  for (const key of ENV_KEYS) if (context.env[key]) env[key] = context.env[key]
  return env
}

async function run(argv, overrides = {}) {
  const context = { print: text => process.stdout.write(`${text}\n`), env: process.env,
    home: os.homedir(), uid: process.getuid?.(), platform: process.platform,
    spawn: spawnSync, load: loadRuntime, ...overrides }
  const request = parse(argv)
  if (request.kind === 'help') { context.print(HELP); return 0 }
  const runtime = context.load()
  if (request.kind === 'version') { context.print(runtime.version); return 0 }
  if (request.kind === 'core') {
    return runtime.run(request.args, { print: text => context.print(text.replaceAll('agentsdock-server', 'agentsdock')) })
  }
  const env = localEnvironment(context)
  const script = path.join(runtime.payload, request.script)
  if (!fs.lstatSync(script).isFile()) throw new Error('The installed server helper is not a regular file.')
  // Preserve the terminal for confirmation/clipboard prompts. Never interpolate
  // a command string, inherit startup hooks, or start a detached helper.
  const result = context.spawn('/bin/bash', [script, ...request.args], { stdio: 'inherit', env })
  if (result.error) throw new Error('Could not start the installed server helper.')
  return Number.isInteger(result.status) ? result.status : 1
}

if (require.main === module) run(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
  process.stderr.write(`agentsdock: ${error.message.replaceAll('agentsdock-server', 'agentsdock')}\n`)
  process.exitCode = 1
})
module.exports = { parse, loadRuntime, localEnvironment, run }
