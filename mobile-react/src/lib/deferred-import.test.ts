import assert from 'node:assert/strict'
import { importWithDeadline } from './deferred-import'

assert.equal(await importWithDeadline(async () => 'ready', 'test module', 25), 'ready')

await assert.rejects(
  importWithDeadline(() => Promise.reject(new Error('module failed')), 'test module', 25),
  /module failed/,
)

await assert.rejects(
  importWithDeadline(() => new Promise<never>(() => undefined), 'stuck module', 5),
  /stuck module did not load within 5 ms/,
)

console.log('deferred import regressions passed')
