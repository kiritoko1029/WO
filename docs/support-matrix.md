# WO Support Matrix

This document distinguishes implemented capability, automated evidence, native-package evidence, and physical-device certification. A row is supported only at the evidence level explicitly recorded here.

## Product scope

| Capability                                | Implemented | Automated evidence                                                 | Physical evidence | Status                     |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------ | ----------------- | -------------------------- |
| Two-person Opus voice                     | Yes         | Unit, signaling integration, and real two-Electron Windows E2E     | None              | IMPLEMENTED, NOT CERTIFIED |
| One simultaneous desktop share            | Yes         | Controller, lease, track-end, and ownership-exchange E2E           | None              | IMPLEMENTED, NOT CERTIFIED |
| Window and monitor source selection       | Yes         | Policy/component tests; dynamic-window E2E only                    | None              | IMPLEMENTED, NOT CERTIFIED |
| Auto / 2 / 4 / 6 / 8 Mbps runtime control | Yes         | Real sender stats prove audio/PC/negotiation continuity            | None              | IMPLEMENTED, NOT CERTIFIED |
| 1920x1080 at 60 fps target                | Yes         | Same-host dynamic-window E2E reports 1920x1080 and at least 55 fps | None              | TARGET ONLY                |
| Direct P2P with self-hosted TURN fallback | Yes         | Real selected-pair stats cover direct and acceptance-forced relay  | None              | IMPLEMENTED, NOT CERTIFIED |

## Desktop packages

| Platform | Architecture | Build                                      | Native signature/notarization       | Package smoke                      | Release status        |
| -------- | ------------ | ------------------------------------------ | ----------------------------------- | ---------------------------------- | --------------------- |
| Windows  | x64          | Automated on Windows                       | NOT TESTED with release certificate | Unsigned development evidence only | NOT RELEASE CERTIFIED |
| macOS    | arm64        | Configuration and simulated verifier tests | NOT TESTED on macOS                 | NOT TESTED                         | NOT RELEASE CERTIFIED |
| macOS    | x64          | Configuration and simulated verifier tests | NOT TESTED on macOS                 | NOT TESTED                         | NOT RELEASE CERTIFIED |
| Mobile   | arm64        | Not implemented                            | N/A                                 | N/A                                | FUTURE                |

Unsigned artifacts are development evidence and must never be published as release artifacts.

## Automated desktop acceptance

The Windows acceptance gate launches two isolated Electron applications against the real `https://rtc.localhost` four-service stack. Each side registers, logs out, logs back in, creates or joins a room, and sends a decoded deterministic non-silent WAV over a real WebRTC audio track. It then captures the existing 1920x1080 dynamic motion window through the production source broker and `getDisplayMedia` path, checks received video frames, exercises every bitrate setting without replacing the PeerConnection or renegotiating, ends a live track, exchanges ownership, drops and recovers WSS, and verifies peer-exit cleanup. The same workflow runs once with normal ICE and once with acceptance-only `iceTransportPolicy: relay`.

This is strong same-host automated evidence, not physical-device certification. It does not cover a monitor source, cross-device GPU/network behavior, macOS screen permission UI, a 600-second run, or a packaged `file://` renderer performing a live screen capture. The packaged `file://` security-origin rule currently has unit and package-smoke evidence only.

## Physical 1080p60 matrix

Every platform direction must pass both `window` and `monitor` sources on both `direct` and externally forced `relay` paths. Ownership exchange is evaluated separately in both directions.

| Publisher -> receiver | Direct window | Direct monitor | Relay window | Relay monitor |
| --------------------- | ------------- | -------------- | ------------ | ------------- |
| Windows -> Windows    | NOT TESTED    | NOT TESTED     | NOT TESTED   | NOT TESTED    |
| Windows -> macOS      | NOT TESTED    | NOT TESTED     | NOT TESTED   | NOT TESTED    |
| macOS -> Windows      | NOT TESTED    | NOT TESTED     | NOT TESTED   | NOT TESTED    |
| macOS -> macOS        | NOT TESTED    | NOT TESTED     | NOT TESTED   | NOT TESTED    |

No row currently authorizes a production claim of certified 1080p60. Same-host Electron E2E evidence does not change the physical matrix. The gate requires two separate physical devices and at least 600 seconds of valid quality evidence. See [1080p60-matrix.md](poc/1080p60-matrix.md).

## Server deployment

| Environment                                        | Evidence                                                                                                     | Status                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Docker Compose on the local Windows Docker runtime | Four-service integration, auth/signaling smoke, TURN UDP/TLS allocation, backup/restore and upgrade rollback | AUTOMATED PASS         |
| Linux Docker host                                  | Compose configuration and image contracts only                                                               | NOT YET HOST-CERTIFIED |
| China mainland public network                      | No production ISP/cross-region measurement                                                                   | NOT TESTED             |

The runtime uses only Caddy, the WO server, PostgreSQL, and coturn. RustFS is reserved for a later object-storage requirement and is intentionally absent from the current voice/screen MVP.
