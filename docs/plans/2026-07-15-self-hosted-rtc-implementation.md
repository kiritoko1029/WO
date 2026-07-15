# Self-Hosted RTC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-hosted Windows/macOS voice-room application for up to 20 users with one 1080p60 desktop share, runtime bitrate control, email/password authentication, RustFS storage, and one-command Docker Compose deployment.

**Architecture:** Use an Electron/React desktop client and a TypeScript modular server that owns REST, versioned Socket.IO signaling, room state, and a pool of native mediasoup Workers. PostgreSQL stores durable identity and room data, Redis stores leases and ephemeral coordination, coturn provides self-hosted relay, and RustFS provides private S3-compatible object storage. Run three blocking media/network proofs before product implementation.

**Tech Stack:** pnpm workspaces, TypeScript, Node.js active LTS, Fastify, Socket.IO, mediasoup/mediasoup-client, Electron, React, Zod, Drizzle ORM, PostgreSQL, Redis, Vitest, Playwright, Docker Compose, coturn, RustFS, Caddy, Prometheus-compatible metrics.

---

## Execution Rules

- Read @superpowers:executing-plans before implementation.
- Use @superpowers:test-driven-development for each behavior change.
- Use @superpowers:systematic-debugging for every failed gate or unexplained media result.
- Use @superpowers:verification-before-completion before claiming any task or milestone complete.
- Do not begin Tasks 6-19 until Tasks 3-5 all pass their explicit gates.
- Do not silently weaken 1080p60, 20-user, dynamic bitrate, TURN, or self-hosting requirements. Record a failed gate and return for a product decision.
- The current workspace is not a Git repository. Task 1 initializes it; after the baseline commit, create a dedicated worktree before continuing if execution is moved to another session.

### Task 1: Initialize the Monorepo and Quality Baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `apps/.gitkeep`
- Create: `packages/.gitkeep`

**Step 1: Initialize Git only because the workspace has no repository**

Run:

```bash
git init
git branch -M main
```

Expected: an empty repository on branch `main`.

**Step 2: Create the workspace manifest**

Use private packages and root scripts for `build`, `test`, `test:integration`, `lint`, `typecheck`, and `format:check`. Pin pnpm through `packageManager` and set Node through `engines` after confirming mediasoup's supported range.

```json
{
  "name": "wo",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:integration": "pnpm -r test:integration",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "format:check": "prettier --check ."
  }
}
```

**Step 3: Install the baseline tools**

Run:

```bash
pnpm add -Dw typescript vitest eslint @eslint/js typescript-eslint prettier
```

Expected: lockfile created with no install errors.

**Step 4: Verify the empty workspace**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all commands exit 0, including packages with no tests.

**Step 5: Commit**

```bash
git add .
git commit -m "chore: initialize rtc monorepo"
```

### Task 2: Define Versioned Protocol and Validated Configuration

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/envelope.ts`
- Create: `packages/protocol/src/auth.ts`
- Create: `packages/protocol/src/room.ts`
- Create: `packages/protocol/src/media.ts`
- Create: `packages/protocol/test/protocol.test.ts`
- Create: `packages/config/package.json`
- Create: `packages/config/src/server.ts`
- Create: `packages/config/test/server.test.ts`

**Step 1: Write failing protocol tests**

Cover protocol version rejection, normalized acknowledgement envelopes, room capacity errors, source types, screen lease messages, and bitrate bounds.

```ts
import { describe, expect, it } from 'vitest';
import { screenBitrateRequestSchema, signalEnvelopeSchema } from '../src';

describe('protocol', () => {
  it('rejects an unsupported protocol version', () => {
    const result = signalEnvelopeSchema.safeParse({
      version: 2,
      requestId: 'req-1',
      type: 'room.join',
      payload: { roomId: 'room-1' }
    });
    expect(result.success).toBe(false);
  });

  it('accepts target bitrate from 1 to 10 Mbps', () => {
    expect(screenBitrateRequestSchema.parse({ maxBitrate: 8_000_000 })).toEqual({
      maxBitrate: 8_000_000
    });
    expect(screenBitrateRequestSchema.safeParse({ maxBitrate: 11_000_000 }).success).toBe(false);
  });
});
```

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/protocol test`

Expected: FAIL because schemas do not exist.

**Step 3: Implement schemas and stable error codes**

Set `PROTOCOL_VERSION = 1`. Define Zod discriminated unions for:

- `auth.refresh`
- `room.join`, `room.leave` and member broadcasts
- `transport.create`, `transport.connect`
- `producer.create`, `producer.close`
- `consumer.create`, `consumer.resume`
- `screen.acquire`, `screen.renew`, `screen.release`
- `screen.setTargetBitrate`

Include `ROOM_FULL`, `FORBIDDEN`, `SCREEN_SHARE_BUSY`, `LEASE_LOST`, `INVALID_STATE`, and `MEDIA_NODE_UNAVAILABLE`.

**Step 4: Add strict server configuration**

Validate public URL, database/Redis/RustFS endpoints, JWT keys, TURN shared secret, mediasoup announced address, Worker port range, and allowed bitrate range. Refuse defaults or placeholder secrets in production.

**Step 5: Run focused and workspace tests**

Run:

```bash
pnpm --filter @wo/protocol test
pnpm --filter @wo/config test
pnpm typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/protocol packages/config
git commit -m "feat: define rtc protocol and configuration"
```

### Task 3: Blocking PoC 1 - Cross-Platform 1080p60 and Dynamic Bitrate

**Files:**
- Create: `packages/media-policy/package.json`
- Create: `packages/media-policy/src/screen-encoding.ts`
- Create: `packages/media-policy/src/stats.ts`
- Create: `packages/media-policy/test/screen-encoding.test.ts`
- Create: `apps/media-lab-server/package.json`
- Create: `apps/media-lab-server/src/index.ts`
- Create: `apps/media-lab-server/src/worker.ts`
- Create: `apps/media-lab-desktop/package.json`
- Create: `apps/media-lab-desktop/src/main.ts`
- Create: `apps/media-lab-desktop/src/preload.ts`
- Create: `apps/media-lab-desktop/src/renderer.ts`
- Create: `apps/media-lab-desktop/src/stats-recorder.ts`
- Create: `docs/poc/1080p60-matrix.md`
- Create: `docs/poc/results/.gitkeep`

**Step 1: Write the failing media-policy tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildScreenEncodings, updateEncodingBitrate } from '../src/screen-encoding';

describe('screen encoding policy', () => {
  it('creates the two fixed RIDs at publish time', () => {
    expect(buildScreenEncodings(8_000_000)).toEqual([
      {
        rid: 'q',
        active: true,
        maxBitrate: 2_000_000,
        maxFramerate: 30,
        scaleResolutionDownBy: 1.5
      },
      {
        rid: 'f',
        active: true,
        maxBitrate: 8_000_000,
        maxFramerate: 60,
        scaleResolutionDownBy: 1
      }
    ]);
  });

  it('changes only the existing full layer', () => {
    const encodings = buildScreenEncodings(8_000_000);
    expect(updateEncodingBitrate(encodings, 4_000_000)[1]?.maxBitrate).toBe(4_000_000);
  });
});
```

**Step 2: Run the test to verify failure**

Run: `pnpm --filter @wo/media-policy test`

Expected: FAIL because the policy functions do not exist.

**Step 3: Implement the pure encoding policy**

Clamp target bitrate to `1_000_000..10_000_000`, never add or reorder an RID after publish, and return new objects rather than mutating sender parameters.

**Step 4: Build the smallest real mediasoup lab**

Implement one Router, one publisher, one receiver, WebRTC transports, and no product authentication. Expose only localhost WSS in the lab. In Electron:

- enumerate screen/window sources through the main process;
- request 1920x1080 at 60 fps;
- publish the two encodings;
- expose codec choice VP8/H.264/VP9;
- apply 2/4/6/8 Mbps changes through `producer.rtpSender.setParameters()`;
- record sender and receiver stats every second.

**Step 5: Add stats report validation**

The report must contain capture settings, codec implementation, `framesEncoded`, `framesDecoded`, width, height, fps, actual bitrate, RTT, loss, NACK, PLI, freeze count, and `qualityLimitationReason`. Unit-test calculation from two `RTCStatsReport` samples.

**Step 6: Run the hardware matrix**

Run a dynamic desktop test for at least ten minutes per available matrix entry:

- Windows Intel integrated GPU
- Windows AMD or NVIDIA GPU
- macOS Apple Silicon
- Intel Mac when available

Test VP8, H.264 and VP9 where the platform advertises support. Save machine-readable results under `docs/poc/results/` and summarize them in `1080p60-matrix.md`.

**Step 7: Apply the blocking gate**

PASS only when at least one common codec path satisfies all of:

- publisher capture and encode are 1920x1080;
- receiver decode is 1920x1080;
- at least 95% of valid samples are 55 fps or higher during dynamic motion;
- 2/4/6/8 Mbps changes settle within five seconds;
- Producer ID remains unchanged;
- no sustained black frame, freeze, or CPU/bandwidth quality limitation on certified hardware.

If no common codec passes, stop. Do not start Task 4 or weaken the requirement.

**Step 8: Commit the reproducible lab and report**

```bash
git add apps/media-lab-* packages/media-policy docs/poc
git commit -m "test: validate cross-platform 1080p60 sharing"
```

### Task 4: Blocking PoC 2 - One Publisher and Nineteen Receivers

**Files:**
- Create: `apps/load-test/package.json`
- Create: `apps/load-test/src/cli.ts`
- Create: `apps/load-test/src/browser-client.ts`
- Create: `apps/load-test/src/scenario.ts`
- Create: `apps/load-test/src/report.ts`
- Create: `apps/load-test/test/report.test.ts`
- Create: `docs/poc/20-user-capacity.md`

**Step 1: Write failing threshold tests**

Given a synthetic report, fail it when clients are fewer than 20, a media session disconnects, memory grows continuously, receiver fps violates the PoC threshold, or server egress exceeds configured capacity.

**Step 2: Run the test to verify failure**

Run: `pnpm --filter @wo/load-test test`

Expected: FAIL because report evaluation does not exist.

**Step 3: Implement a deterministic Chromium client**

Each client creates an AudioContext-generated audio track. One client also creates a dynamic 1920x1080 canvas track at 60 fps with moving fine text and animation. Do not use a static image. All 20 clients publish audio and subscribe to the other 19 audio Producers; 19 subscribe to the screen Producer.

**Step 4: Implement scenario and telemetry**

Capture:

- 20 client connection states;
- 20 audio Producers and 380 audio Consumers;
- one screen Producer and 19 screen Consumers;
- media-node CPU/RSS/event-loop delay;
- ingress/egress bytes and retransmission;
- sender and receiver WebRTC stats.

**Step 5: Run a short CI smoke test**

Run:

```bash
pnpm --filter @wo/load-test start --clients 4 --duration 120 --screen-bitrate 2000000
```

Expected: exit 0 with a JSON report.

**Step 6: Run the blocking production-shaped test**

Run on the intended Linux server:

```bash
pnpm --filter @wo/load-test start --clients 20 --duration 7200 --screen-bitrate 8000000
```

Expected: 20 clients remain connected for two hours, no Worker block/crash, no monotonic memory leak, and all media counts match.

**Step 7: Apply the blocking gate**

PASS only when one 1+19 screen scenario plus 20-way voice stays inside the planned `200-300 Mbps` room budget on a 1 Gbps node and preserves acceptable audio. Record the actual safe rooms-per-node value; do not extrapolate from CPU alone.

**Step 8: Commit**

```bash
git add apps/load-test docs/poc/20-user-capacity.md
git commit -m "test: establish twenty-user media capacity"
```

### Task 5: Blocking PoC 3 - Self-Hosted TURN and Public Deployment

**Files:**
- Create: `deploy/lab/compose.yaml`
- Create: `deploy/lab/coturn/turnserver.conf`
- Create: `deploy/lab/caddy/Caddyfile`
- Create: `deploy/lab/.env.example`
- Create: `scripts/check-rtc-ports.mjs`
- Create: `apps/media-lab-desktop/src/ice-mode.ts`
- Create: `docs/poc/turn-public-network.md`

**Step 1: Write a failing preflight test**

Test that preflight rejects loopback announced addresses, missing TURN secret, overlapping Worker ports, unresolvable public names, and TURN TLS on the same IP/443 as Caddy.

**Step 2: Run the test to verify failure**

Run: `pnpm vitest scripts/check-rtc-ports.test.ts`

Expected: FAIL because preflight is absent.

**Step 3: Implement the lab deployment**

- Bind one WebRtcServer UDP/TCP port per mediasoup Worker.
- Set `announcedAddress` to the static public IPv4.
- Run coturn with host networking, `3478/udp,tcp`, `5349/tcp`, and a bounded relay UDP range.
- Issue time-limited TURN REST credentials from the lab server.
- Do not configure Google or any other public STUN.
- Use a separate public IP if TURN/TLS must listen on 443.

**Step 4: Add selectable ICE modes**

The lab client supports `all`, `direct-only`, and `relay-only`. Log the selected candidate pair and assert that relay-only actually reports candidate type `relay`.

**Step 5: Test network paths**

Test:

- direct UDP;
- mediasoup TCP fallback;
- TURN UDP;
- TURN TCP/TLS;
- forced 3% loss;
- 100 ms and 200 ms RTT;
- publisher bandwidth drop and recovery.

Use China Telecom, China Unicom and China Mobile access where available; record missing carrier coverage as a release risk, not as a pass.

**Step 6: Apply the blocking gate**

PASS only when voice and screen work through self-hosted TURN, no runtime request targets a public STUN/CDN, and the deployment can be recreated from documented environment variables on a clean Linux host.

**Step 7: Commit**

```bash
git add deploy/lab scripts apps/media-lab-desktop docs/poc/turn-public-network.md
git commit -m "test: validate self-hosted turn deployment"
```

### Task 6: Add Database Schema and Repositories

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/schema/users.ts`
- Create: `packages/database/src/schema/auth.ts`
- Create: `packages/database/src/schema/rooms.ts`
- Create: `packages/database/src/schema/objects.ts`
- Create: `packages/database/src/repositories/*.ts`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/migrations/0001_initial.sql`
- Create: `packages/database/test/schema.integration.test.ts`

**Step 1: Write failing integration tests**

Use Testcontainers PostgreSQL. Verify:

- email identities are unique by provider plus normalized identifier;
- email is not the user primary key;
- password credential is separate from identity;
- room live-capacity configuration cannot exceed 20;
- room membership is unique;
- refresh session token hashes are unique;
- deleting a user handles dependent rows explicitly.

**Step 2: Run the integration test to verify failure**

Run: `pnpm --filter @wo/database test:integration`

Expected: FAIL because schema and migration are missing.

**Step 3: Implement Drizzle schema and migration**

Use UUID primary keys, UTC timestamps, explicit indexes, and database constraints. Do not store raw refresh tokens, invitations, or object URLs.

**Step 4: Implement narrow repository interfaces**

Create repositories for users/identities, credentials, refresh sessions, rooms/members/invites, and object metadata. Keep transaction boundaries in service methods, not hidden across multiple repository calls.

**Step 5: Run migration twice**

Run migration against a clean database and then rerun to verify no pending changes.

**Step 6: Verify**

Run:

```bash
pnpm --filter @wo/database test:integration
pnpm --filter @wo/database typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/database
git commit -m "feat: add identity and room persistence"
```

### Task 7: Implement Email/Password Authentication

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/modules/auth/auth.service.ts`
- Create: `apps/server/src/modules/auth/auth.routes.ts`
- Create: `apps/server/src/modules/auth/password.ts`
- Create: `apps/server/src/modules/auth/tokens.ts`
- Create: `apps/server/src/modules/auth/auth.schemas.ts`
- Create: `apps/server/test/auth.integration.test.ts`

**Step 1: Write failing API tests**

Test registration, duplicate normalized email, login failure without user enumeration, access token expiry, refresh rotation, reused refresh-token family revocation, logout, disabled user, and rate limiting.

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/server test -- auth.integration`

Expected: FAIL because routes do not exist.

**Step 3: Implement password and token primitives**

Use Argon2id with calibrated parameters. Generate opaque 256-bit refresh tokens, store only SHA-256 hashes, rotate on every refresh, and sign short-lived access JWTs with `jose`. Inject time and randomness for deterministic tests.

**Step 4: Implement auth service transactions**

Registration creates user, email identity and password credential atomically. Refresh locks and rotates the current session atomically. Reuse revokes the token family.

**Step 5: Implement routes**

Expose:

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/me`

Do not expose email verification or automatic password reset until an SMTP decision is approved.

**Step 6: Verify**

Run:

```bash
pnpm --filter @wo/server test -- auth
pnpm --filter @wo/server typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: add email password authentication"
```

### Task 8: Implement Rooms, Membership, Invites, and Capacity

**Files:**
- Create: `apps/server/src/modules/rooms/room.service.ts`
- Create: `apps/server/src/modules/rooms/room.routes.ts`
- Create: `apps/server/src/modules/rooms/room.schemas.ts`
- Create: `apps/server/test/rooms.integration.test.ts`

**Step 1: Write failing service and route tests**

Cover create/list/get room, owner/member permissions, short-lived invite creation and revocation, join by invite, leave, duplicate invite use according to policy, and owner cannot orphan a room. Persistent membership may exceed 20; online media capacity is tested in Tasks 10-11.

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/server test -- rooms`

Expected: FAIL.

**Step 3: Implement transactional membership**

Lock invite and membership rows when accepting an invite, apply expiry/use-count rules, and make repeated acceptance idempotent. Do not count persistent members as live media participants.

**Step 4: Implement REST routes**

Add `/v1/rooms`, `/v1/rooms/:id`, member endpoints, and invite endpoints. Return protocol error codes.

**Step 5: Verify race behavior**

Run concurrent tests for invite use and duplicate membership creation. Assert uniqueness and use limits hold without restricting the room to 20 persistent members.

**Step 6: Commit**

```bash
git add apps/server/src/modules/rooms apps/server/test/rooms.integration.test.ts
git commit -m "feat: add room membership and capacity"
```

### Task 9: Implement the Redis Screen-Share Lease

**Files:**
- Create: `apps/server/src/modules/screen-share/screen-lease.ts`
- Create: `apps/server/src/modules/screen-share/acquire.lua`
- Create: `apps/server/src/modules/screen-share/renew.lua`
- Create: `apps/server/src/modules/screen-share/release.lua`
- Create: `apps/server/test/screen-lease.integration.test.ts`

**Step 1: Write failing lease tests**

Test one winner under 50 concurrent acquire requests, owner-only renewal, stale owner release rejection, automatic 15-second expiry with a fake clock where possible, disconnect cleanup, and Redis restart behavior.

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/server test:integration -- screen-lease`

Expected: FAIL.

**Step 3: Implement atomic scripts**

Store `userId`, `connectionId` and random `leaseId`. Acquire with NX and 15-second TTL, renew every five seconds only when the full value matches, and release only on an exact lease match.

**Step 4: Add authoritative room checks**

The media room registry must reject a second screen Producer even if a lease is forged or Redis is inconsistent. When Redis is unavailable, reject new sharing while preserving current media.

**Step 5: Verify**

Run integration tests against a real Redis container and repeat the race test at least 100 times.

**Step 6: Commit**

```bash
git add apps/server/src/modules/screen-share apps/server/test/screen-lease.integration.test.ts
git commit -m "feat: enforce single screen share lease"
```

### Task 10: Promote the Validated mediasoup Core into the Server

**Files:**
- Create: `apps/server/src/modules/media/worker-pool.ts`
- Create: `apps/server/src/modules/media/media-room.ts`
- Create: `apps/server/src/modules/media/peer-session.ts`
- Create: `apps/server/src/modules/media/transport-factory.ts`
- Create: `apps/server/src/modules/media/codecs.ts`
- Create: `apps/server/src/modules/media/media-errors.ts`
- Create: `apps/server/test/media-room.test.ts`
- Modify: `packages/media-policy/src/screen-encoding.ts`

**Step 1: Write failing domain tests with mediasoup fakes**

Test one Router per room, least-loaded healthy Worker selection, an atomic maximum of 20 live peers, exactly one winner when two connections compete for the final slot, one microphone Producer per peer, one screen Producer per room, paused Consumer creation, peer cleanup, and Worker death cleanup.

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/server test -- media-room`

Expected: FAIL.

**Step 3: Implement WorkerPool**

Start a bounded number of Workers based on validated configuration. Create one WebRtcServer per Worker on a distinct UDP/TCP port and set `announcedAddress`. Track Consumer count and health.

**Step 4: Implement MediaRoom and PeerSession**

Keep mediasoup objects in memory only. Assign a room to one Worker/Router for its lifetime. Close transports, Producers and Consumers idempotently. Propagate Worker death as `MEDIA_NODE_UNAVAILABLE` and evict all affected sessions.

**Step 5: Freeze codec policy from Task 3**

Copy only the codec order and encoding policy that passed the cross-platform matrix. Document the selected path in code and keep the fallback explicit.

**Step 6: Run a real Worker integration test**

Start a real mediasoup Worker, create/close a room repeatedly, and verify no leaked Router/Transport objects.

**Step 7: Commit**

```bash
git add apps/server/src/modules/media apps/server/test packages/media-policy
git commit -m "feat: add mediasoup room orchestration"
```

### Task 11: Implement Authenticated Versioned Signaling

**Files:**
- Create: `apps/server/src/modules/signaling/gateway.ts`
- Create: `apps/server/src/modules/signaling/auth-middleware.ts`
- Create: `apps/server/src/modules/signaling/handlers/room.ts`
- Create: `apps/server/src/modules/signaling/handlers/transport.ts`
- Create: `apps/server/src/modules/signaling/handlers/producer.ts`
- Create: `apps/server/src/modules/signaling/handlers/consumer.ts`
- Create: `apps/server/src/modules/signaling/handlers/screen.ts`
- Create: `apps/server/test/signaling.integration.test.ts`

**Step 1: Write failing signaling tests**

Cover invalid token, unsupported protocol version, non-member join, room-full response, transport create/connect, unauthorized Producer source, paused Consumer handshake, second screen rejection, malformed acknowledgement, disconnect cleanup, and request idempotency.

**Step 2: Run the tests to verify failure**

Run: `pnpm --filter @wo/server test:integration -- signaling`

Expected: FAIL.

**Step 3: Implement the gateway**

Parse every inbound and outbound message with `@wo/protocol`. Require access JWT during handshake. Attach stable userId and random connectionId server-side. Never accept those identities from payload data.

**Step 4: Implement media handlers**

Use ack-based request/response for mutations and broadcasts for room state. Create remote Consumers paused; resume only after the client has created its local Consumer.

**Step 5: Implement share handlers**

Acquire before capture, renew every five seconds, release idempotently, and validate the lease again when creating `source=screen`. Clamp requested target bitrate server-side.

**Step 6: Verify**

Run:

```bash
pnpm --filter @wo/server test
pnpm --filter @wo/server test:integration
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/server/src/modules/signaling apps/server/test/signaling.integration.test.ts
git commit -m "feat: add authenticated rtc signaling"
```

### Task 12: Build the Secure Electron Shell and Core UI

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/security.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/preload/types.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/routes/*.tsx`
- Create: `apps/desktop/src/renderer/src/components/*.tsx`
- Create: `apps/desktop/src/renderer/src/styles.css`
- Create: `apps/desktop/test/security.test.ts`
- Create: `apps/desktop/test/app.test.tsx`

**Step 1: Write failing security and UI tests**

Assert `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`, navigation/window-open denial, strict IPC channel allowlist, no remote content, and CSP. Test login, room list and in-room control rendering.

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/desktop test`

Expected: FAIL.

**Step 3: Create the Electron boundary**

Expose only typed APIs for app version, platform permissions, capture-source listing, and approved settings. Do not expose raw `ipcRenderer` or filesystem access.

**Step 4: Build the desktop workflow**

The first screen is the login/register workflow, then room list, then the operational room view. Use restrained work-tool styling, Lucide icons for familiar actions, tooltips for icon-only controls, fixed dimensions for the bottom call toolbar, and no nested cards.

**Step 5: Add API session storage**

Keep access token in renderer memory. Store refresh token using an OS-backed secure store from the main process; if the selected library cannot provide secure storage on a supported OS, block release rather than writing it to localStorage.

**Step 6: Verify desktop security**

Run unit/component tests and inspect the packaged BrowserWindow preferences.

**Step 7: Commit**

```bash
git add apps/desktop
git commit -m "feat: add secure desktop application shell"
```

### Task 13: Add Voice Publishing and Playback

**Files:**
- Create: `apps/desktop/src/renderer/src/media/signaling-client.ts`
- Create: `apps/desktop/src/renderer/src/media/device.ts`
- Create: `apps/desktop/src/renderer/src/media/voice-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/audio-output.ts`
- Create: `apps/desktop/src/renderer/src/state/call-store.ts`
- Create: `apps/desktop/src/renderer/src/components/CallToolbar.tsx`
- Create: `apps/desktop/src/renderer/src/components/ParticipantList.tsx`
- Create: `apps/desktop/test/voice-controller.test.ts`

**Step 1: Write failing controller tests**

Mock mediaDevices and mediasoup-client. Test permission denial, preferred microphone selection, Opus constraints, exactly one microphone Producer, mute/unmute without republish, device hot-swap with `replaceTrack`, remote Consumer attachment, output mute, and cleanup.

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/desktop test -- voice-controller`

Expected: FAIL.

**Step 3: Implement the signaling and Device handshake**

Join room, load Router RTP capabilities, create send/receive transports, and implement paused remote Consumer creation.

**Step 4: Implement voice**

Request echo cancellation, noise suppression and auto gain. Publish Opus with DTX/FEC settings proven compatible. Use one Audio element per remote track and clean it up deterministically.

**Step 5: Implement call controls**

Add microphone selection, output selection where supported, mute, deafen and active-speaker state. Controls must not resize when labels or speaking state changes.

**Step 6: Verify with two real clients**

Run one Windows/macOS pair where available. Check device hot-plug and permission denial.

**Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/media apps/desktop/src/renderer/src/state apps/desktop/src/renderer/src/components apps/desktop/test
git commit -m "feat: add realtime voice rooms"
```

### Task 14: Add Single Desktop Share and Runtime Bitrate Control

**Files:**
- Create: `apps/desktop/src/main/capture-sources.ts`
- Create: `apps/desktop/src/main/permissions.ts`
- Create: `apps/desktop/src/renderer/src/media/screen-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/bitrate.ts`
- Create: `apps/desktop/src/renderer/src/components/SourcePicker.tsx`
- Create: `apps/desktop/src/renderer/src/components/ScreenShareToolbar.tsx`
- Create: `apps/desktop/src/renderer/src/components/ScreenStage.tsx`
- Create: `apps/desktop/test/screen-controller.test.ts`
- Create: `apps/desktop/test/bitrate.test.ts`

**Step 1: Write failing bitrate tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyScreenBitrate } from '../src/renderer/src/media/bitrate';

it('updates the existing full encoding without renegotiation', async () => {
  const setParameters = vi.fn();
  const sender = {
    getParameters: () => ({
      encodings: [
        { rid: 'q', maxBitrate: 2_000_000 },
        { rid: 'f', maxBitrate: 8_000_000 }
      ]
    }),
    setParameters
  };

  await applyScreenBitrate(sender as never, 4_000_000);

  expect(setParameters).toHaveBeenCalledWith({
    encodings: [
      { rid: 'q', maxBitrate: 2_000_000 },
      { rid: 'f', maxBitrate: 4_000_000 }
    ]
  });
});
```

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/desktop test -- bitrate screen-controller`

Expected: FAIL.

**Step 3: Implement secure source selection**

List only sanitized screen/window metadata and thumbnail data through preload. On macOS, check screen-recording status and show the correct system-permission action. Do not capture system audio in MVP.

**Step 4: Implement lease-first sharing**

Acquire the server lease, then request a source, then publish. If selection is cancelled, release immediately. On `track.onended`, disconnect or Producer close, release idempotently. Renew only while the Producer is live.

**Step 5: Implement validated 1080p60 publishing**

Use the exact codec and encoding parameters selected in Task 3. After capture, show actual `track.getSettings()`. After publish, use outbound stats for the real quality indicator.

**Step 6: Implement bitrate controls**

Provide Auto, 2, 4, 6 and 8 Mbps presets plus a 1-10 Mbps advanced slider. Apply `setParameters` to the full RID and send the clamped target to the server. On platform rejection, restore the last valid value and show a concise error.

**Step 7: Test single-share races**

Launch two clients and trigger share simultaneously. Assert one publishes and the other receives `SCREEN_SHARE_BUSY`. Kill the winner and verify a new share can begin after lease cleanup.

**Step 8: Commit**

```bash
git add apps/desktop/src apps/desktop/test
git commit -m "feat: add adjustable desktop sharing"
```

### Task 15: Implement Reconnect and Recoverable State Machines

**Files:**
- Create: `apps/desktop/src/renderer/src/media/connection-machine.ts`
- Create: `apps/desktop/src/renderer/src/media/reconnect-policy.ts`
- Create: `apps/desktop/test/connection-machine.test.ts`
- Create: `apps/server/test/media-recovery.integration.test.ts`

**Step 1: Write failing state-machine tests**

Cover WSS short loss, token refresh during reconnect, ICE disconnected grace, ICE restart, transport recreation, server restart, Worker death, network switch, sleep/wake, and losing a screen lease while disconnected.

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/desktop test -- connection-machine`

Expected: FAIL.

**Step 3: Implement explicit states**

Use `idle -> signaling -> joining -> connected -> degraded -> reconnecting -> failed`. Make transitions observable and idempotent. Use bounded exponential backoff with jitter.

**Step 4: Implement media recovery**

Attempt ICE restart during the grace window. If it fails, recreate transports and republish microphone. Never assume old mediasoup IDs survive. A previous screen owner must acquire a new valid lease before republishing.

**Step 5: Add server fault integration tests**

Restart server/Redis, kill a Worker, and block UDP. Assert stable user-facing state and cleanup.

**Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/media apps/desktop/test apps/server/test/media-recovery.integration.test.ts
git commit -m "feat: recover realtime sessions after disconnects"
```

### Task 16: Integrate Private RustFS Object Storage

**Files:**
- Create: `apps/server/src/modules/objects/object-store.ts`
- Create: `apps/server/src/modules/objects/object.service.ts`
- Create: `apps/server/src/modules/objects/object.routes.ts`
- Create: `apps/server/test/rustfs.contract.test.ts`
- Create: `deploy/rustfs/lifecycle.json`

**Step 1: Write failing RustFS contract tests**

Against a real RustFS container, test bucket bootstrap, path-style request, small upload, multipart upload, retry after transient failure, object metadata, short signed download URL, unauthorized key access, delete, and lifecycle configuration.

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/server test:integration -- rustfs`

Expected: FAIL.

**Step 3: Implement the S3 client**

Use AWS SDK v3 with `forcePathStyle: true`, private endpoint, bounded timeouts/retries, and credentials from validated server configuration. Keep RustFS unreachable from the public network.

**Step 4: Implement object authorization**

Store only bucket/key metadata. Return short-lived signed URLs after checking the authenticated owner or room permission. Never persist a permanent public URL.

**Step 5: Prove media isolation**

Stop RustFS during an active call. Assert voice and screen continue while object routes return a retryable storage error.

**Step 6: Commit**

```bash
git add apps/server/src/modules/objects apps/server/test/rustfs.contract.test.ts deploy/rustfs
git commit -m "feat: add private rustfs object storage"
```

### Task 17: Build Production Docker Compose Deployment

**Files:**
- Create: `apps/server/Dockerfile`
- Create: `deploy/compose.yaml`
- Create: `deploy/.env.example`
- Create: `deploy/caddy/Caddyfile`
- Create: `deploy/coturn/turnserver.conf`
- Create: `deploy/postgres/init/.gitkeep`
- Create: `deploy/scripts/preflight.sh`
- Create: `deploy/scripts/backup.sh`
- Create: `deploy/scripts/restore-test.sh`
- Create: `docs/deployment.md`
- Create: `tests/deploy/compose.test.ts`

**Step 1: Write failing deployment tests**

Parse Compose and assert:

- required services and health checks exist;
- PostgreSQL, Redis and RustFS admin ports are not public;
- persistent volumes exist;
- migration job gates server readiness;
- no `latest` image tags;
- no default passwords;
- coturn and mediasoup advertise explicit public addresses;
- restart policies and log rotation are configured.

**Step 2: Run the test to verify failure**

Run: `pnpm vitest tests/deploy/compose.test.ts`

Expected: FAIL.

**Step 3: Create production images and Compose**

Use a multi-stage Debian-based server image compatible with the validated mediasoup release. Pin images by version or digest. Compose includes `gateway`, `migrate`, `server`, `postgres`, `redis`, `rustfs` and `coturn`. Add optional `observability` and future `recorder` profiles.

**Step 4: Implement preflight**

Validate Linux host, Docker/Compose versions, static public IP, DNS, TLS mode, port availability, firewall instructions, disk paths, free space, secrets, RustFS credentials, and kernel UDP buffer recommendations.

**Step 5: Implement backup and restore drill**

Back up PostgreSQL and RustFS metadata/data according to the chosen topology. A backup is not accepted until `restore-test.sh` restores into isolated volumes and validates records/objects.

**Step 6: Verify one-command startup**

On a clean supported Linux host:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.yaml up -d
```

Expected: migration finishes, all core services become healthy, authenticated API works, and a real ICE/media probe succeeds.

**Step 7: Commit**

```bash
git add apps/server/Dockerfile deploy docs/deployment.md tests/deploy
git commit -m "ops: add one-command self-hosted deployment"
```

### Task 18: Add Observability, Quality Diagnostics, and Security Gates

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/logger.ts`
- Create: `packages/observability/src/metrics.ts`
- Create: `apps/server/src/modules/health/health.routes.ts`
- Create: `apps/server/src/modules/health/media-probe.ts`
- Create: `apps/desktop/src/renderer/src/media/stats-monitor.ts`
- Create: `apps/desktop/src/renderer/src/components/QualityIndicator.tsx`
- Create: `deploy/observability/prometheus.yml`
- Create: `tests/security/runtime-endpoints.test.ts`

**Step 1: Write failing privacy and health tests**

Assert secrets, email, SDP and window titles are redacted; liveness does not depend on storage; readiness fails for dead Worker/DB/Redis; RustFS failure degrades object readiness only; and the media probe performs a real ICE/media exchange.

**Step 2: Run tests to verify failure**

Run: `pnpm vitest tests/security apps/server/test/health`

Expected: FAIL.

**Step 3: Add structured logs and metrics**

Log requestId, roomId, connectionId and anonymized user ID. Export Worker CPU, room/peer/Producer/Consumer counts, transport bytes, ICE pair type, TURN ratio, reconnects and share-lease contention.

**Step 4: Add client stats monitor**

Aggregate every five seconds and upload minute summaries: bitrate, dimensions, fps, RTT, jitter, loss, NACK/PLI, freezes and quality limitation. Never upload source names or pixels.

**Step 5: Add runtime endpoint audit**

During an end-to-end call, record DNS and HTTP/WSS/ICE destinations. Fail if any runtime media, STUN, script, font, telemetry or update endpoint is outside the configured self-hosted allowlist.

**Step 6: Verify**

Run full tests and inspect dashboards during the 20-client smoke scenario.

**Step 7: Commit**

```bash
git add packages/observability apps/server/src/modules/health apps/desktop/src/renderer/src tests/security deploy/observability
git commit -m "feat: add rtc diagnostics and health probes"
```

### Task 19: Complete Cross-Platform E2E, Packaging, and Release Evidence

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/e2e/auth.spec.ts`
- Create: `apps/desktop/e2e/room.spec.ts`
- Create: `apps/desktop/e2e/screen-share.spec.ts`
- Create: `scripts/run-acceptance.mjs`
- Create: `docs/release-checklist.md`
- Create: `docs/support-matrix.md`
- Create: `docs/operations/runbook.md`

**Step 1: Write failing E2E tests**

Automate registration/login, create/join room, 21st-user rejection, mute, device switch where virtual devices are available, one-share race, bitrate change, track-ended cleanup, reconnect and logout.

**Step 2: Run tests to verify failure**

Run: `pnpm --filter @wo/desktop test:e2e`

Expected: FAIL until all workflows are wired.

**Step 3: Implement packaging**

Build signed Windows x64 installers and signed/notarized macOS Apple Silicon packages; add Intel macOS only if the PoC support decision includes it. Keep signing credentials outside the repository. Do not add an external auto-update endpoint to MVP.

**Step 4: Run final automated verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
docker compose --env-file deploy/.env.test -f deploy/compose.yaml config
pnpm --filter @wo/desktop test:e2e
```

Expected: all commands exit 0.

**Step 5: Run release acceptance**

Execute the design document's real-device matrix:

- Windows/macOS cross-call;
- dynamic 1080p60 for ten minutes with 95% samples at 55 fps or higher on both sender and receiver;
- 2/4/6/8 Mbps changes within five seconds without Producer recreation;
- 20 clients for two hours;
- direct UDP, TCP and relay-only paths;
- loss/latency/bandwidth fault cases;
- concurrent sharing race and lease expiry;
- sleep/wake, device hot-plug and permission denial;
- clean-host Compose install, restart, backup and restore.

**Step 6: Record evidence**

Write exact app/server versions, hardware, codec, network conditions, reports, known limitations and capacity limits into `docs/support-matrix.md` and the release checklist. A requirement is complete only when linked evidence exists.

**Step 7: Request review**

Use @superpowers:requesting-code-review for the full change set. Address findings, rerun the affected tests, then use @superpowers:verification-before-completion.

**Step 8: Commit**

```bash
git add apps/desktop/e2e apps/desktop/electron-builder.yml scripts docs
git commit -m "test: complete desktop rtc release acceptance"
```

## Milestone Exit Criteria

### PoC Exit

- Tasks 3, 4 and 5 all pass without requirement waivers.
- Codec and certified hardware matrix are frozen.
- Single-room bandwidth and Worker capacity are measured.
- Self-hosted TURN works on target public networks.

### MVP Exit

- Tasks 6-15 pass unit, integration and desktop workflow tests.
- Email/password, rooms, 20-way voice, one screen share, adjustable bitrate and reconnect work end-to-end.

### Deployable Release Exit

- Tasks 16-19 pass.
- Clean Linux host deployment requires only documented infrastructure, environment values and one Compose command.
- Runtime endpoint audit confirms no third-party RTC/STUN/CDN dependency.
- Windows/macOS support matrix and 1080p60 evidence are published with the release.
