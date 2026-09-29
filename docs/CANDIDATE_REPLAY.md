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
- Separate `stage-recovery` jobs cover both legacy root modes. A private,
  run-owned dependency delegate fails one exact signed candidate's preparation.
  The real installer must remove its stage and release its lock, while both
  incumbent components, service registrations and data remain unchanged. Retry
  uses the same public update API and accepted bytes. The delegate remains an
  explicitly disclosed QA dependency until the disposable VM ends.

The recovery fault does not modify signed bytes, patch the updater, remove update
fences, signal the incumbent, or establish post-takeover rollback. Installer state,
private fixture tokens, TLS keys, native logs and screenshots are not uploaded.
Only bounded sanitized observation JSON is retained; trust/routing cleanup runs
before artifact upload even after failure.

The stage-recovery check does not remove staging files itself or repair journals.
It reports maintenance-fence cleanup and post-takeover rollback as unobserved;
passing this earlier preparation failure is not evidence of either later phase.

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
and the separate stable-fixture download step receive it as `GH_TOKEN` and use
read operations. It is not exported to the
installed software. No production signing secrets or publication commands are in
these jobs.

Dispatch `ci.yml` on the receipt's reviewed `release/*` branch with:

```text
candidate_replay=true
candidate_tag=candidate-replay-v1.0.8-beta.2
candidate_receipt_sha256=<independently reviewed candidate.json SHA-256>
candidate_bundle_sha256=<independently reviewed candidate-bundle.zip SHA-256>
npm_native_validation=false
```

Leave all npm-only artifact inputs empty. The two native modes are mutually
exclusive; ordinary source CI does neither installation journey. Existing npm-only
validation remains available separately and does not establish desktop acceptance.
Do not invoke the hosted-runner trust/process helpers on a developer machine or
an existing local guest, and never remove an app's `disable-auto-update` marker.

## Separate stable-server no-downgrade case

Stable server `1.0.8` must not be downgraded to the receipt's `1.0.8-beta.N`
candidate (currently `1.0.8-beta.2`). The fixture accepts only that same-base
numbered Beta line and binds every observation to the exact signed candidate
receipt; it rejects other bases, Stable, RC and locally relabeled versions.
That requires a
distinct native fixture and observation, not weakening the positive migration's
strictly-older-baseline assertion. The separate `candidate-no-downgrade` job
installs genuine stable server `1.0.8` on its own disposable hosted macOS runner,
then launches the exact signed beta app directly. It does not replace an older
desktop, install origin routing, or alter TLS trust.

The stable archive and signed descriptor are independent inputs, never rewritten
candidate receipt fields. The helper pins stable source
`8a965007408c6ab9672d746366b9fc0bd58feff6`, descriptor SHA-256
`64881777ab0ebf8ad029ec1f4f1212e1699f9ee7a1d62420ae32e5f3dcfe7198`,
and archive SHA-256
`c9846ca863312478f64979cc579feea521902dc23c15f0f30ca5eebdb544808f`.
CI downloads the official `npm-candidate-v1.0.8` draft's three files and compares
its archive byte-for-byte with anonymous official npm registry delivery before
the helper verifies the committed release-key signature and exact stable pins.
Neither the stable release nor its registry tags are changed.

The native helper observes the app's coordination requests through a transparent
loopback relay, checks its real settings UI, and verifies that the healthy stable
service identity and process remain unchanged. Its separate bounded reports have
kind `candidate-no-downgrade-observations` and retain both
`publicationEligible: false` and `releaseAcceptance: false`. Candidate artifact
source, truthful harness source, and stable fixture source remain distinct. A
passing unit suite only validates the harness contract; this native case is not
accepted until the exact signed-package job runs and its observations are reviewed.

## Deliberately uncovered

This rehearsal does not establish authenticated provider-history preservation, busy or
queued real work, logout/reboot, Linux candidate-health rollback, Windows native
update acceptance, or real public-feed/registry delivery. Inspect the structured
reports for blocked checks; scoped observations cannot authorize publication.
