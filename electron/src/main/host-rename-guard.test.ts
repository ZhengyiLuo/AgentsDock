import { describe, expect, it, vi } from 'vitest'
import { AppService } from './service'

const scope = { profileId: 'profile-test', profileGeneration: 3, serverIdentity: 'server-test' }
const capability = { available: true, version: 1, enabled: true, can_enable: false, can_disable: true,
  rename_existing_host: true, status_path: '/api/admin/team-hub/host', enable_path: '/api/admin/team-hub/host/enable',
  disable_path: '/api/admin/team-hub/host/disable', message: 'Host ready', action: null }
function fixture(advertised: unknown = capability) {
  const enable = vi.fn().mockRejectedValue(new Error('isolated dispatch boundary'))
  const service = Object.create(AppService.prototype) as AppService
  Object.assign(service, { health: { capabilities: { team_hub_host_control_v1: advertised } },
    securePeerControlContext: vi.fn().mockResolvedValue({ expected: scope, serverInstanceId: 'instance-test', scope: { client: { enableTeamHubHost: enable } } }) })
  return { service, enable }
}
describe('safe existing Host rename', () => {
  it('rejects old capability, changed role and network-name changes before dispatch', async () => {
    for (const advertised of [{ ...capability, rename_existing_host: undefined }, { ...capability, enabled: false, can_enable: true }]) {
      const { service, enable } = fixture(advertised)
      await expect(service.configureTeamHubServerRole(scope, { role: 'host', serverName: 'New name', renameOnly: true })).rejects.toThrow()
      expect(enable).not.toHaveBeenCalled()
    }
    const { service, enable } = fixture()
    await expect(service.configureTeamHubServerRole(scope, { role: 'host', serverName: 'New name', renameOnly: true, networkName: 'Different team' })).rejects.toThrow('preserve')
    expect(enable).not.toHaveBeenCalled()
  })
  it('binds accepted Rename to the existing Host precondition without creating a network', async () => {
    const { service, enable } = fixture()
    await expect(service.configureTeamHubServerRole(scope, { role: 'host', serverName: 'New name', renameOnly: true })).rejects.toThrow('isolated dispatch boundary')
    expect(enable).toHaveBeenCalledTimes(1)
    expect(enable).toHaveBeenCalledWith({ request_id: expect.any(String), expected_server_identity: 'server-test',
      expected_server_instance_id: 'instance-test', confirmed: true, server_name: 'New name', require_existing_host: true })
  })
})
