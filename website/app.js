const fallbackRelease = {
  version: 'Private preview',
  platforms: {
    macos: { available: false, label: 'macOS build is being prepared' },
    linux: { available: false, label: 'Linux build is being prepared' }
  }
}

let release = fallbackRelease

async function loadRelease() {
  try {
    const response = await fetch('./releases/latest.json', { cache: 'no-store' })
    if (!response.ok) throw new Error(`Release manifest returned ${response.status}`)
    release = await response.json()
  } catch {
    release = fallbackRelease
  }
  const releaseVersion = document.querySelector('#release-version')
  if (releaseVersion) releaseVersion.textContent = release.version ? `Version ${release.version}` : 'Private preview'
  updatePlatform('macos')
  updatePlatform('linux')
}

function updatePlatform(platform) {
  const entry = release.platforms?.[platform] || fallbackRelease.platforms[platform]
  document.querySelectorAll(`[data-download="${platform}"]`).forEach(button => {
    button.classList.toggle('unavailable', !entry.available)
    button.setAttribute('aria-disabled', String(!entry.available))
    button.dataset.status = entry.label || ''
    if (entry.available) button.setAttribute('aria-label', `Download AgentsDock ${entry.version || release.version} for ${platform}`)
  })
  const checksum = document.querySelector(`#${platform}-checksum`)
  if (checksum && entry.sha256) checksum.textContent = `SHA256 ${entry.sha256}`
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-download]')
  if (!button) return
  const entry = release.platforms?.[button.dataset.download] || fallbackRelease.platforms[button.dataset.download]
  const status = document.querySelector('#download-status')
  if (!entry.available || !entry.url) {
    status.textContent = entry.label || 'This package is not published yet.'
    document.querySelector('#downloads').scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  status.textContent = `Starting ${entry.filename || 'download'}…`
  window.location.assign(entry.url)
})

loadRelease()
