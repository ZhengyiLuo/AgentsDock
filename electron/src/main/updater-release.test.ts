import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

describe('direct release contract', () => {
  const packageJSON = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    main: string
    build: {
      mac: { target: string[]; artifactName: string }
      linux: { target: string[]; artifactName: string; executableArgs: string[] }
      win: { target: Array<{ target: string; arch: string[] }>; artifactName: string; verifyUpdateCodeSignature: boolean }
      nsis: { oneClick: boolean; perMachine: boolean; allowElevation: boolean; allowToChangeInstallationDirectory: boolean; differentialPackage: boolean }
      publish: Array<{ provider: string; owner: string; repo: string; channel: string; releaseType: string }>
    }
  }
  const releaseScript = readFileSync(resolve(process.cwd(), '../scripts/build_electron_release.sh'), 'utf8')
  const releaseVerifyScript = readFileSync(resolve(process.cwd(), '../scripts/verify_electron_release.sh'), 'utf8')
  const linuxBuildScript = readFileSync(resolve(process.cwd(), '../scripts/build_electron_linux.sh'), 'utf8')
  const linuxVerifyScript = readFileSync(resolve(process.cwd(), '../scripts/verify_electron_linux.sh'), 'utf8')
  const updaterProviderScript = readFileSync(resolve(process.cwd(), 'node_modules/electron-updater/out/providers/Provider.js'), 'utf8')
  const linuxWorkflowPath = resolve(process.cwd(), '../.github/workflows/linux-desktop-build.yml')
  const windowsWorkflowPath = resolve(process.cwd(), '../.github/workflows/windows-desktop-build.yml')
  const windowsBuildScript = readFileSync(resolve(process.cwd(), '../scripts/build_electron_windows.ps1'), 'utf8')
  const windowsVerifyScript = readFileSync(resolve(process.cwd(), '../scripts/verify_electron_windows.ps1'), 'utf8')
  const asarSwapScript = readFileSync(resolve(process.cwd(), 'scripts/asar-swap-regression.mjs'), 'utf8')
  const draftWorkflowPath = resolve(process.cwd(), '../.github/workflows/direct-desktop-release-draft.yml')
  const publishWorkflowPath = resolve(process.cwd(), '../.github/workflows/direct-desktop-release-publish.yml')
  const releaseVersionGuard = readFileSync(resolve(process.cwd(), '../scripts/validate_electron_release_version.mjs'), 'utf8')

  it('keeps updater artifacts and a public read-only GitHub feed', () => {
    const expectedChannel = process.env.AGENTSDOCK_RELEASE_TRACK === 'beta' ? 'beta' : 'latest'

    expect(packageJSON.build.mac.target).toEqual(expect.arrayContaining(['zip', 'dmg']))
    expect(packageJSON.build.mac.artifactName).toContain('${version}')
    expect(packageJSON.build.mac.artifactName).toContain('${arch}')
    expect(packageJSON.build.linux.target).toEqual(expect.arrayContaining(['AppImage', 'tar.gz']))
    expect(packageJSON.build.linux.artifactName).toContain('${version}')
    expect(packageJSON.build.linux.artifactName).toContain('${arch}')
    expect(packageJSON.build.linux.executableArgs).toEqual([])
    expect(packageJSON.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJSON.build.win.artifactName).toBe('${productName}-${version}-win-${arch}.${ext}')
    expect(packageJSON.build.win.verifyUpdateCodeSignature).toBe(true)
    expect(packageJSON.build.nsis).toEqual(expect.objectContaining({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      differentialPackage: true
    }))
    expect(packageJSON.build.publish).toEqual([{
      provider: 'github',
      owner: 'ZhengyiLuo',
      repo: 'AgentsDock',
      channel: expectedChannel,
      releaseType: 'draft'
    }])
  })

  it('builds locally without publishing and verifies before handoff', () => {
    expect(releaseScript).toContain('--publish never')
    expect(releaseScript).toContain('--config.mac.notarize=true')
    expect(releaseScript).toContain('verify_electron_release.sh')
    expect(releaseScript).not.toContain('GH_TOKEN')
    expect(releaseScript).not.toContain('print $2; exit')
    expect(releaseVerifyScript).toContain('Zip blockmap size does not match the update zip')
    expect(releaseVerifyScript).toContain('Packaged Mach-O is not universal')
    expect(releaseVerifyScript).toContain('clean-runner smoke window')
    expect(releaseVerifyScript).not.toContain('print $2; exit')
    expect(linuxBuildScript).toContain('--publish never')
    expect(linuxBuildScript).toContain('AGENTSDOCK_LINUX_ARCH')
    expect(linuxBuildScript).toContain('--arm64')
    expect(linuxVerifyScript).toContain('latest-linux.yml')
    expect(linuxVerifyScript).toContain('beta-linux.yml')
    expect(linuxVerifyScript).toContain('${METADATA_NAME%.yml}-arm64.yml')
    expect(linuxVerifyScript).toContain('EXPECTED_RUNNER_ARCH="aarch64"')
    expect(linuxVerifyScript).toContain('metadata.files')
    expect(linuxVerifyScript).toContain('FUSE_SENTINEL')
    expect(linuxVerifyScript).toContain("filter='data'")
    expect(linuxVerifyScript).toContain('AppImage and tarball application payloads differ')
    expect(linuxVerifyScript).toContain('AppImage and tarball updater configurations differ')
    expect(linuxVerifyScript).toContain('disable-auto-update')
    expect(linuxVerifyScript).toContain('AgentsDock')
    expect(linuxVerifyScript).toContain('desktop launcher must not force --no-sandbox')
    expect(linuxVerifyScript).not.toContain('AppRun\" --no-sandbox')
    expect(linuxVerifyScript).toContain('SMOKE_EXIT\" -ne 124')
    expect(linuxVerifyScript).toContain('xvfb-run')
    expect(linuxVerifyScript).toContain('APPIMAGE_EXTRACT_AND_RUN=1')
    expect(updaterProviderScript).toContain('const archSuffix = arch === "x64" ? "" : `-${arch}`')
    expect(windowsBuildScript).toContain('--publish never')
    expect(windowsBuildScript).toContain('--win nsis --x64')
    expect(windowsBuildScript).toContain('--exclude src/main/server-setup.test.ts')
    expect(windowsBuildScript).toContain('$BuilderAttempts = 3')
    expect(windowsBuildScript).toContain('$BuilderRetryDelays = @(15, 45)')
    expect(windowsBuildScript).toContain('for ($Attempt = 1; $Attempt -le $BuilderAttempts; $Attempt++)')
    expect(windowsBuildScript).toContain('Start-Sleep -Seconds $DelaySeconds')
    const windowsBuilderLoop = windowsBuildScript.slice(windowsBuildScript.indexOf('for ($Attempt = 1'))
    expect(windowsBuilderLoop.indexOf('Remove-Item -LiteralPath $Output -Recurse -Force'))
      .toBeLessThan(windowsBuilderLoop.indexOf('& pnpm exec electron-builder'))
    expect(windowsBuildScript).toContain("$Installer = @(Get-ChildItem")
    expect(windowsVerifyScript).toContain("'latest.yml'")
    expect(windowsVerifyScript).toContain("'beta.yml'")
    expect(windowsVerifyScript).toContain('Get-AuthenticodeSignature')
    expect(windowsVerifyScript).toContain('require-signed')
    expect(windowsVerifyScript).toContain("'unsigned stable override'")
    expect(windowsVerifyScript).toContain("'unsigned beta preview'")
    expect(windowsVerifyScript).toContain('Get-Sha512Base64')
    expect(windowsVerifyScript).toContain('AgentsDock.exe machine')
    expect(windowsVerifyScript).toContain('clean-runner smoke window')
    expect(windowsVerifyScript).toContain('Uninstall*.exe')
    expect(windowsVerifyScript).toContain("'/currentuser'")
    expect(windowsVerifyScript).toContain('taskkill.exe')
    expect(windowsVerifyScript).toContain('Silent uninstaller left AgentsDock.exe installed')
    expect(windowsVerifyScript).toContain('Windows ${ExpectedArchitecture}: exact installer')
    expect(windowsVerifyScript).toContain('EnableEmbeddedAsarIntegrityValidation is Enabled')
    expect(packageJSON.main).toBe('./out/main/index.js')
    expect(windowsVerifyScript).toContain("$MainEntry -eq './out/main/index.js'")
    expect(windowsVerifyScript).toContain('ASAR declared main entry is truncated')
    expect(windowsVerifyScript).not.toContain('index.mjs')
    expect(asarSwapScript).toContain("'out/main/index.js'")
    expect(asarSwapScript).not.toContain("'out/main/index.mjs'")
  })

  it('keeps the release-version guard strict without requiring maintainer workflows', () => {
    expect(releaseVersionGuard).toContain('must be greater than public AgentsDock')
    expect(releaseVersionGuard).toContain("release.draft ?? release.isDraft")
  })

  // Source-only snapshots intentionally omit maintainer publishing workflows.
  // Only their contract tests are conditional; runtime and script checks above always run.
  it.skipIf(!existsSync(linuxWorkflowPath))('checks the maintainer Linux workflow (omitted from source-only snapshots)', () => {
    const linuxWorkflow = readFileSync(linuxWorkflowPath, 'utf8')
    expect(linuxWorkflow).toContain('verify_electron_linux.sh')
    expect(linuxWorkflow).toContain('build-linux-arm64:')
    expect(linuxWorkflow).toContain('runs-on: ubuntu-24.04-arm')
    expect(linuxWorkflow).toContain('AGENTSDOCK_LINUX_ARCH: arm64')
    expect(linuxWorkflow).toContain('linux-arm64-verified')
    expect(linuxWorkflow).toContain('actions/upload-artifact@')
    expect(linuxWorkflow).not.toMatch(/uses:\s+\S+@v\d/)
    expect(linuxWorkflow).not.toContain('gh release create')
    expect(linuxWorkflow).not.toContain('GH_TOKEN')
  })

  it.skipIf(!existsSync(windowsWorkflowPath))('checks the maintainer Windows workflow (omitted from source-only snapshots)', () => {
    const windowsWorkflow = readFileSync(windowsWorkflowPath, 'utf8')
    expect(windowsWorkflow).toContain('runs-on: windows-2025')
    expect(windowsWorkflow).toContain('verify_electron_windows.ps1')
    expect(windowsWorkflow).toContain('actions/upload-artifact@')
    expect(windowsWorkflow).not.toMatch(/uses:\s+\S+@v\d/)
    expect(windowsWorkflow).not.toContain('gh release create')
    expect(windowsWorkflow).not.toContain('AGENTSDOCK_RELEASE_TOKEN')
    expect(windowsWorkflow).not.toContain('WINDOWS_CERTIFICATE_PFX_BASE64')
    expect(windowsWorkflow).toContain('Pull-request code must never receive the future Authenticode PFX.')
  })

  describe.skipIf(!existsSync(draftWorkflowPath) || !existsSync(publishWorkflowPath))('maintainer direct-release workflows (omitted from source-only snapshots)', () => {
    let draftWorkflow: string
    let publishWorkflow: string

    beforeAll(() => {
      draftWorkflow = readFileSync(draftWorkflowPath, 'utf8')
      publishWorkflow = readFileSync(publishWorkflowPath, 'utf8')
    })

    it('publishes and verifies against the same dedicated release repository', () => {
      expect(draftWorkflow).toContain('--repo ZhengyiLuo/AgentsDock-Releases')
      expect(publishWorkflow).toContain('--repo ZhengyiLuo/AgentsDock-Releases')
      expect(publishWorkflow).toContain('https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/latest/download/latest-mac.yml')
      expect(publishWorkflow).toContain('https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/latest/download/latest-linux.yml')
      expect(publishWorkflow).toContain('https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/latest/download/latest-linux-arm64.yml')
      expect(publishWorkflow).toContain('https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/latest/download/latest.yml')
      expect(`${draftWorkflow}\n${publishWorkflow}`).not.toContain('/AgentsServer')
    })

    it('seals macOS, Linux, and Windows into one immutable source-pinned release', () => {
      expect(draftWorkflow).toContain('build-macos:')
      expect(draftWorkflow).toContain('build-linux-x64:')
      expect(draftWorkflow).toContain('build-linux-arm64:')
      expect(draftWorkflow).toContain('build-windows-x64:')
      expect(draftWorkflow).toContain('runs-on: ubuntu-24.04-arm')
      expect(draftWorkflow).toContain('runs-on: windows-2025')
      expect(draftWorkflow).toContain('environment: direct-production')
      expect(draftWorkflow).toContain('allow_unsigned_windows:')
      expect(draftWorkflow).toContain('Stable Windows releases require Authenticode unless allow_unsigned_windows is explicitly approved.')
      expect(draftWorkflow).toContain('Windows signing: %s')
      expect(draftWorkflow).toContain('verify_electron_linux.sh')
      expect(draftWorkflow).toContain('verify_electron_windows.ps1')
      expect(draftWorkflow).toContain('latest-linux.yml')
      expect(draftWorkflow).toContain('latest-linux-arm64.yml')
      expect(draftWorkflow).toContain('AgentsDock-${RELEASE_VERSION}-linux-arm64.AppImage')
      expect(draftWorkflow).toContain('AgentsDock-${RELEASE_VERSION}-linux-arm64.tar.gz')
      expect(draftWorkflow).toContain('sha256sum AgentsDock-*')
      expect(publishWorkflow).toContain('verify-macos:')
      expect(publishWorkflow).toContain('verify-linux-x64:')
      expect(publishWorkflow).toContain('verify-linux-arm64:')
      expect(publishWorkflow).toContain('verify-windows-x64:')
      expect(publishWorkflow).toContain('verify_electron_release.sh')
      expect(publishWorkflow).toContain('verify_electron_linux.sh')
      expect(publishWorkflow).toContain('verify_electron_windows.ps1')
      expect(publishWorkflow).toContain('allow_unsigned_windows:')
      expect(publishWorkflow).toContain('Publishing an unsigned stable Windows installer requires allow_unsigned_windows.')
      expect(publishWorkflow).toContain('windows_signing_policy: ${{ steps.inspect.outputs.windows_signing_policy }}')
      expect(publishWorkflow).toContain('WINDOWS_SIGNING_POLICY: ${{ needs.inspect-draft.outputs.windows_signing_policy }}')
      expect(publishWorkflow).not.toContain("if ($env:RELEASE_TRACK -eq 'stable') { 'require-signed' }")
      expect(publishWorkflow).toContain('Draft inspection and platform verifiers observed different checksum manifests.')
      expect(publishWorkflow).toContain('downloaded-assets.txt')
      expect(`${draftWorkflow}\n${publishWorkflow}`).not.toMatch(/uses:\s+\S+@v\d/)
    })

    it('keeps stable and beta feeds isolated', () => {
      expect(draftWorkflow).toContain('x.y.z-beta.N')
      expect(draftWorkflow).toContain("p.build.publish[0].channel=process.env.RELEASE_TRACK==='beta'?'beta':'latest'")
      expect(publishWorkflow).toContain('beta-mac.yml')
      expect(publishWorkflow).toContain('beta-linux.yml')
      expect(publishWorkflow).toContain('beta-linux-arm64.yml')
      expect(publishWorkflow).toContain('beta.yml')
      expect(publishWorkflow).toContain('AgentsDock-Releases/releases.atom')
      expect(publishWorkflow).toContain('DISCOVERED_VERSION')
      expect(publishWorkflow).toContain('scripts/select_electron_beta_release.mjs')
      expect(publishWorkflow).not.toContain('awk -v expected="$RELEASE_VERSION"')
      expect(publishWorkflow).not.toContain("sed -n 's#.*releases/tag/v\\([^\"]*\\)\".*#\\1#p' | head -1")
      expect(publishWorkflow).toContain('DISCOVERED_MAC_VERSION')
      expect(publishWorkflow).toContain('DISCOVERED_LINUX_ARM64_VERSION')
      expect(publishWorkflow).toContain('DISCOVERED_WINDOWS_VERSION')
      expect(publishWorkflow).toContain('--prerelease --latest=false')
      expect(publishWorkflow).toContain('"$LATEST_TAG" != "v${RELEASE_VERSION}"')
    })

    it('rejects stale release versions before building or publishing', () => {
      const draftValidationJob = draftWorkflow.slice(
        draftWorkflow.indexOf('  validate-request:'),
        draftWorkflow.indexOf('  build-macos:')
      )
      const finalPublishStep = publishWorkflow.slice(
        publishWorkflow.indexOf('      - name: Publish reviewed release'),
        publishWorkflow.indexOf('      - name: Verify public updater metadata')
      )
      expect(draftWorkflow).toContain('node scripts/validate_electron_release_version.mjs "$RELEASE_VERSION" "$RELEASE_TRACK"')
      expect(publishWorkflow).toContain('node scripts/validate_electron_release_version.mjs "$RELEASE_VERSION" "$RELEASE_TRACK"')
      expect(`${draftWorkflow}\n${publishWorkflow}`).toContain('AgentsDock-Releases/releases?per_page=100')
      expect(draftValidationJob).toContain('GH_TOKEN: ${{ secrets.AGENTSDOCK_RELEASE_TOKEN }}')
      expect(draftValidationJob).not.toContain('environment:')
      expect(draftValidationJob).not.toContain('github.token')
      expect(finalPublishStep).toContain('GH_TOKEN: ${{ secrets.AGENTSDOCK_RELEASE_TOKEN }}')
      expect(finalPublishStep).toContain('node scripts/validate_electron_release_version.mjs "$RELEASE_VERSION" "$RELEASE_TRACK"')
      expect(finalPublishStep.indexOf('validate_electron_release_version.mjs'))
        .toBeLessThan(finalPublishStep.indexOf('gh release edit'))
    })

    it('replays verification from the source commit recorded by the draft', () => {
      expect(publishWorkflow).toContain('ref: ${{ needs.inspect-draft.outputs.source_sha }}')
      expect(publishWorkflow).toContain('git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main')
      expect(publishWorkflow).toContain('Source commit: //p')
      expect(publishWorkflow).toContain('Checksum manifest changed after platform verification.')
    })
  })
})
