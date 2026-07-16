# WO Release Checklist

Release is blocked unless every applicable item is checked and linked to immutable evidence.

## Source and automated gates

- [ ] Working tree contains only reviewed release changes.
- [ ] `pnpm install --frozen-lockfile` succeeds with the pinned Node and pnpm versions.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build` pass.
- [ ] Contract tests confirm exactly four runtime services: Caddy, server, PostgreSQL, and coturn.
- [ ] Production resource scan contains no password, token, ticket, raw SDP/ICE address, TURN credential, email, room code, source title, private key, acceptance hook, or certificate bypass.
- [ ] Renderer bundle contains no Node built-in import.
- [ ] Electron fuses are verified from the final packaged executable.
- [ ] Native Windows desktop E2E passes both real two-Electron direct and acceptance-forced relay workflows against the four-service stack (`pnpm test:e2e:desktop`).
- [ ] Acceptance E2E uses the pinned current Caddy CA SPKI, rejects a mismatched pin/host/error, and leaves no Electron process or temporary profile.
- [ ] A fresh production build scan proves the acceptance app ID, WAV IPC, diagnostics IPC, certificate handler, and control hooks are absent.

## Server deployment

- [ ] Production secrets were generated outside Git and have restricted permissions.
- [ ] `deploy/scripts/preflight` passes before any service is changed.
- [ ] Backup and staging restore pass before upgrade.
- [ ] Internal smoke passes while Caddy is still closed to public traffic.
- [ ] Auth registration/login/refresh/logout, two-person capacity, room resume/reset, screen lease, and TURN UDP/TLS proofs pass.
- [ ] Upgrade rollback and data rollback evidence are attached.
- [ ] Logs were searched for all prohibited sensitive values.

## Windows release

- [ ] Built on a native Windows x64 runner.
- [ ] Final NSIS and portable artifacts contain the expected x64 PE application.
- [ ] Authenticode chain, expected publisher identity, and trusted timestamp match the release configuration.
- [ ] Normal startup loads main, preload, and renderer from the final artifact and reaches the readiness probe without a certificate bypass.
- [ ] A final packaged `file://` renderer performs one live window share on Windows; this remains required even when the development-origin E2E passes.
- [ ] No child process or temporary profile remains after smoke.
- [ ] Artifact SHA-256 values are recorded.

## macOS release

- [ ] Built separately on native macOS x64 and arm64 runners.
- [ ] ZIP and DMG contents contain the correct architecture and bundle identifier.
- [ ] Nested code and the final app pass `codesign --verify --deep --strict`.
- [ ] Team ID matches the expected release team.
- [ ] Gatekeeper assessment, notarization, and stapling pass for the final distributable artifacts.
- [ ] Hardened runtime, microphone usage text, screen-capture usage text, and both entitlements files are present.
- [ ] Normal startup loads main, preload, and renderer from each final artifact.
- [ ] Artifact SHA-256 values are recorded.

## Physical media certification

- [ ] Every claimed row in [support-matrix.md](support-matrix.md) has a passing 45-second two-device preflight.
- [ ] Every claimed row has a passing 600-second formal run for both direct and externally forced relay paths.
- [ ] Both window and monitor sources were measured.
- [ ] Capture, encode, decode, and presentation remain 1920x1080 with at least 95% of valid windows at or above 55 fps.
- [ ] Audio packets, samples, and energy progress with no gap above two seconds through share and bitrate changes.
- [ ] Auto/2/4/6/8 Mbps changes preserve PeerConnection, transceiver count, screen MID, and negotiation count.
- [ ] Forced relay evidence contains zero non-relay selected-pair samples; direct evidence contains zero relay samples.
- [ ] Installer/archive, executable, `app.asar`, and resource hashes match on both devices.
- [ ] Firewall watchdog and final restoration are proven on both devices.
- [ ] Evidence is privacy-redacted and the gate output is `HARDWARE_PASS`.

Any unchecked physical row remains `NOT TESTED`; it must not be inferred from another OS, GPU, source type, network path, or direction.
