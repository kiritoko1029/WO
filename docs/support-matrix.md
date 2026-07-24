# WO Support Matrix

This document distinguishes implemented capability, automated evidence, native-package evidence, and physical-device certification. A row is supported only at the evidence level explicitly recorded here.

## Product scope

| Capability                                | Implemented | Automated evidence                                                 | Physical evidence | Status                     |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------ | ----------------- | -------------------------- |
| Two-person Opus voice                     | Yes         | Unit, signaling integration, and real two-Electron Windows E2E     | None              | IMPLEMENTED, NOT CERTIFIED |
| One simultaneous desktop share            | Yes         | Controller, lease, track-end, and ownership-exchange E2E           | None              | IMPLEMENTED, NOT CERTIFIED |
| Window and monitor source selection       | Yes         | Policy/component tests; dynamic-window E2E only                    | None              | IMPLEMENTED, NOT CERTIFIED |
| Auto / 5 / 10 / 20 Mbps runtime control   | Yes         | Real sender stats prove audio/PC/negotiation continuity            | None              | IMPLEMENTED, NOT CERTIFIED |
| 1920x1080 at 60 fps target                | Yes         | Same-host dynamic-window E2E reports 1920x1080 and at least 55 fps | None              | TARGET ONLY                |
| Direct P2P with self-hosted TURN fallback | Yes         | Real selected-pair stats cover direct and acceptance-forced relay  | None              | IMPLEMENTED, NOT CERTIFIED |
| Canonical HTTPS backend selection         | Yes         | Store, precedence, IPC, renderer, and package-gate tests           | None              | IMPLEMENTED, NOT CERTIFIED |
| HTTPS and `wo://` room invitations        | Yes         | Parser, lifecycle, one-shot delivery, UI, and package-gate tests   | None              | IMPLEMENTED, NOT CERTIFIED |
| Same-origin Web client                    | Yes         | Two-session Chromium voice E2E, adapter, build, deploy contracts   | None              | IMPLEMENTED, NOT CERTIFIED |
| Trusted-LAN lightweight room core         | Yes         | HMAC frame, private-address, two-person, and shutdown integration  | None              | IMPLEMENTED, NOT CERTIFIED |

The LAN row records the room-service and protocol implementation, not a
physical two-desktop certification. A six-digit room code is display-only and
cannot discover the host; the full invite also carries a private endpoint and a
256-bit key. HMAC authenticates signaling frames but does not encrypt the
`ws://`/`http://` transport, so this mode is restricted to a trusted RFC1918
LAN.

The current media plan has three fixed m-lines: microphone audio, system audio,
and screen video. Mixed rooms containing an older two-m-line desktop build are
not supported. Deployments must upgrade or roll back the complete active client
cohort; the signaling server does not translate SDP between those media plans.

## Client entry points

| Client / path                  | Backend rule                 | Screen share                         | Evidence                                         | Status                     |
| ------------------------------ | ---------------------------- | ------------------------------------ | ------------------------------------------------ | -------------------------- |
| Electron desktop               | Configurable canonical HTTPS | Electron source broker               | Unit, component, build, and package-gate tests   | IMPLEMENTED, NOT CERTIFIED |
| Desktop Chrome / Edge Web      | Current page origin only     | Native `getDisplayMedia()` selector  | Real Chromium voice E2E, build, deploy contracts | IMPLEMENTED, NOT CERTIFIED |
| Safari / Firefox desktop Web   | Current page origin only     | Capability-dependent, not guaranteed | No compatibility certification                   | NOT CERTIFIED              |
| Mobile Web                     | Current page origin only     | Not promised                         | No compatibility certification                   | NOT CERTIFIED              |
| Trusted-LAN desktop-to-desktop | Private invite endpoint      | Reuses desktop WebRTC path           | Automated service integration only               | IMPLEMENTED, NOT CERTIFIED |

The Web refresh token is stored only in the current origin's `sessionStorage`;
closing the tab requires login again. Web does not offer arbitrary cross-origin
backend selection.

## Desktop packages

| Platform | Architecture | Build                               | Native signature/notarization       | Package smoke                      | Release status        |
| -------- | ------------ | ----------------------------------- | ----------------------------------- | ---------------------------------- | --------------------- |
| Windows  | x64          | Automated on Windows                | NOT TESTED with release certificate | Unsigned development evidence only | NOT RELEASE CERTIFIED |
| macOS    | arm64        | Unsigned DMG and ZIP built on macOS | NOT TESTED signed or notarized      | Strict final-artifact smoke passed | NOT RELEASE CERTIFIED |
| macOS    | x64          | Unsigned DMG and ZIP built on macOS | NOT TESTED signed or notarized      | Strict final-artifact smoke passed | NOT RELEASE CERTIFIED |
| Linux    | x64/arm64    | No release package                  | N/A                                 | NOT TESTED                         | NOT CERTIFIED         |
| Mobile   | arm64        | Not implemented                     | N/A                                 | N/A                                | FUTURE                |

Unsigned artifacts are development evidence and must never be published as release
artifacts.
Certification scope is limited to Windows and macOS desktop plus Chrome and
Edge Web. Linux desktop, Safari, Firefox, and mobile remain `NOT CERTIFIED`.

## Automated desktop acceptance

The Windows acceptance gate launches two isolated Electron applications against the real `https://rtc.localhost` four-service stack. Each side registers, logs out, logs back in, creates or joins a room, and sends a decoded deterministic non-silent WAV over a real WebRTC audio track. It then captures the existing 1920x1080 dynamic motion window through the production source broker and `getDisplayMedia` path, checks received video frames, exercises every bitrate setting without replacing the PeerConnection or renegotiating, ends a live track, exchanges ownership, drops and recovers WSS, and verifies peer-exit cleanup. The same workflow runs once with normal ICE and once with acceptance-only `iceTransportPolicy: relay`.

This is strong same-host automated evidence, not physical-device certification. It
does not cover a monitor source, cross-device GPU/network behavior, macOS screen
permission UI, a 600-second run, or a packaged `wo-app://` renderer performing a
live screen capture. The packaged `wo-app://bundle/index.html` security origin,
strict CSP, WASM compilation, and RNNoise chunk loading have final-artifact smoke
evidence; live media capture from the unsigned package remains untested.

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

| Environment                                        | Evidence                                                                                                                                                    | Status                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Docker Compose on the local Windows Docker runtime | Four-service integration, Web build/routing configuration contracts, auth/signaling smoke, TURN UDP/TCP/TLS relay data, backup/restore and upgrade rollback | AUTOMATED PASS         |
| Linux Docker host                                  | Compose configuration and image contracts only                                                                                                              | NOT YET HOST-CERTIFIED |
| China mainland public network                      | No production ISP/cross-region measurement                                                                                                                  | NOT TESTED             |

The runtime uses only Caddy, the WO server, PostgreSQL, and coturn. Caddy serves
the Web SPA from its image, so Web does not add another long-running service.
RustFS is reserved for a later object-storage requirement and is intentionally
absent from the current voice/screen MVP.
