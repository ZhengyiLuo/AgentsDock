import { AGENTS_SERVER_REPOSITORY_URL, inferServerConfigured } from './server-setup'

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
}

assertEqual(inferServerConfigured(undefined, undefined), false)
assertEqual(inferServerConfigured('', undefined), false)
assertEqual(inferServerConfigured('127.0.0.1:7850', undefined), false)
assertEqual(inferServerConfigured('http://localhost:7850/', undefined), false)
assertEqual(inferServerConfigured('100.64.0.1:7850', undefined), true)
assertEqual(inferServerConfigured('http://127.0.0.1:7850', true), true)
assertEqual(inferServerConfigured('100.64.0.1:7850', false), false)
assertEqual(AGENTS_SERVER_REPOSITORY_URL, 'https://github.com/ZhengyiLuo/AgentsServer')

console.log('server setup regressions passed')
