import { describe, expect, it } from 'vitest'
import type { Health } from '@shared/types'
import {
  providerJobsAccessDescription,
  providerJobsAccessLabel,
  providerJobsAccessState
} from './provider-jobs-access'

const supportedHealth: Health = {
  ok: true,
  capabilities: {
    provider_jobs_access_control_v1: {
      available: true,
      required: false,
      message: 'Ready',
      action: null,
      version: 1,
      modes: ['full', 'read_only', 'blocked'],
      default: 'full'
    }
  }
}

describe('provider scheduled-jobs access', () => {
  it('uses the server default for an existing chat without a stored override', () => {
    expect(providerJobsAccessState({}, supportedHealth)).toEqual({
      available: true,
      effective: 'full',
      inheritedDefault: true
    })
  })

  it('uses the durable per-chat value when present', () => {
    expect(providerJobsAccessState({ provider_jobs_access: 'blocked' }, supportedHealth)).toEqual({
      available: true,
      effective: 'blocked',
      inheritedDefault: false
    })
  })

  it('fails closed when an older or incomplete capability cannot enforce the setting', () => {
    expect(providerJobsAccessState({ provider_jobs_access: 'blocked' }, { ok: true })).toEqual({
      available: false,
      effective: 'full',
      inheritedDefault: true
    })
    expect(providerJobsAccessState({}, {
      ok: true,
      capabilities: {
        provider_jobs_access_control_v1: {
          available: true,
          required: false,
          message: 'Incomplete',
          action: null,
          version: 1,
          modes: ['full', 'blocked'],
          default: 'full'
        }
      }
    })).toMatchObject({ available: false, effective: 'full' })
  })

  it('provides explicit labels and agent-only behavior copy', () => {
    expect(providerJobsAccessLabel('read_only')).toBe('Read-only')
    expect(providerJobsAccessDescription('blocked')).toContain('agent cannot access')
    expect(providerJobsAccessDescription('full')).toContain('Agent run-now remains unavailable')
  })
})
