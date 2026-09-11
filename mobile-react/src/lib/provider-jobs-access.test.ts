import assert from 'node:assert/strict'
import type { Health, Session } from '../types'
import { providerJobsAccessState } from './provider-jobs-access'

const session = { provider_jobs_access: null } as Pick<Session, 'provider_jobs_access'>
const capable: Health = {
  ok: true,
  capabilities: {
    provider_jobs_access_control_v1: {
      available: true,
      version: 1,
      modes: ['full', 'read_only', 'blocked'],
      default: 'read_only',
    },
  },
}

assert.deepEqual(providerJobsAccessState(session, capable), {
  available: true,
  inheritedDefault: true,
  effective: 'read_only',
})
assert.deepEqual(providerJobsAccessState({ provider_jobs_access: 'blocked' }, capable), {
  available: true,
  inheritedDefault: false,
  effective: 'blocked',
})
assert.deepEqual(providerJobsAccessState({ provider_jobs_access: 'blocked' }, {
  ok: true,
  capabilities: {
    provider_jobs_access_control_v1: {
      available: true,
      version: 1,
      modes: ['full', 'blocked'],
      default: 'blocked',
    },
  },
}), {
  available: false,
  inheritedDefault: true,
  effective: 'full',
}, 'partial capability advertisements must fail closed to the legacy UI behavior')

console.log('provider jobs access regressions passed')
