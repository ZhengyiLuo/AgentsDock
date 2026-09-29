# Unpublished macOS candidate rehearsal

This is a scoped test in the existing registered `ci.yml`, not a product release
workflow. It installs exact signed packages and changes origin routing/trust only
on disposable GitHub-hosted macOS runners. It never signs or publishes packages.
All candidate receipts and observations remain `publicationEligible: false`;
observations also remain `releaseAcceptance: false`. A successful job does not
turn blocked or unobserved scenarios into full release acceptance.

## Exact journey

- Desktop baseline: published, update-enabled, signed/notarized AgentsDock
  `1.0.6` from the legacy desktop feed. The real settings UI first checks Stable,
  then selects Beta and retains Beta through installation and relaunch.
- Server baseline: the published signed legacy AgentsServer `1.0.7-beta.21`
  archive. This is the same-Beta **server** path; no local beta desktop is used.
- Target: the one independently pinned unpublished beta app/server candidate.
  The real app updater installs its exact signed macOS ZIP. The production
  coordinator updates the populated server after an offline/reconnect interval;
  a second native client must observe the same update operation.
- Separate disposable jobs exercise legacy installation-root modes `0755` and
  `0750`. Each mode also has a separate recovery job that truncates one response
  containing the exact signed legacy archive, observes failed download and the
  unchanged healthy incumbent, then retries the same version normally.
- A fresh-install job exercises the exact npm archive and native service manager.

The recovery fault does not modify signed bytes, patch the updater, remove update
fences, signal the incumbent, or establish post-takeover rollback. Installer state,
private fixture tokens, TLS keys, native logs and screenshots are not uploaded.
Only bounded sanitized observation JSON is retained; trust/routing cleanup runs
before artifact upload even after failure.

## Source and artifact contract

Commit this harness before freezing the candidate source. Package all targets and
the signed npm/legacy descriptors from the same reviewed source. A later harness
retry must descend from that source, change only the existing explicit test/docs
allowlist, and keep truthful, distinct artifact and harness commit identities.
Runtime, build payload and production authorization changes are not harness-only
retries. Never forge `GITHUB_SHA` or a successful preparation run.

The candidate receipt requires an exact original successful standalone signing
run/attempt and its immutable Actions archive digest. Its server bundle verifies
both signatures, canonical source/export identity, runtime bytes and executable
modes. It includes the original signer archive and verified import report. The
macOS asset set and embedded server descriptor are also byte-bound. Sealing is
not signing and cannot manufacture missing signer provenance.

The unpublished `candidate-replay-vVERSION` draft must contain exactly
`candidate.json` and `candidate-bundle.zip`, target the packaged source commit,
and remain an unpublished prerelease. Review their SHA-256 hashes independently.
The candidate input action verifies everything before installation or trust
changes. GitHub requires `contents: write` on the job token to read an unpublished
draft; this is not a technically read-only credential. Only the input action
receives it as `GH_TOKEN` and uses read operations. It is not exported to the
installed software. No production signing secrets or publication commands are in
this job.

Dispatch `ci.yml` on the receipt's reviewed `release/*` branch with:

```text
candidate_replay=true
candidate_tag=candidate-replay-v1.0.8-beta.1
candidate_receipt_sha256=<independently reviewed candidate.json SHA-256>
candidate_bundle_sha256=<independently reviewed candidate-bundle.zip SHA-256>
npm_native_validation=false
```

Leave all npm-only artifact inputs empty. The two native modes are mutually
exclusive; ordinary source CI does neither installation journey. Existing npm-only
validation remains available separately and does not establish desktop acceptance.
Do not invoke the hosted-runner trust/process helpers on a developer machine or
an existing local guest, and never remove an app's `disable-auto-update` marker.

## Deliberately uncovered

Stable server `1.0.8` must not be downgraded to `1.0.8-beta.1`. That requires a
distinct native fixture and observation, not weakening the positive migration's
strictly-older-baseline assertion. This replay does not yet exercise that case.
It also does not establish authenticated provider-history preservation, busy or
queued real work, logout/reboot, Linux candidate-health rollback, Windows native
update acceptance, or real public-feed/registry delivery. Inspect the structured
reports for blocked checks; scoped observations cannot authorize publication.
