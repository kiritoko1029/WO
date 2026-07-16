# Two-Person P2P RTC MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a self-hosted Windows/macOS application where two email/password users join a temporary six-digit room, talk over WebRTC audio, and use one adjustable-bitrate desktop share.

**Architecture:** Use one native `RTCPeerConnection` between the two Electron clients, with a pre-negotiated Opus audio transceiver and screen-video transceiver. A Fastify application authenticates users, owns in-memory temporary-room state, relays versioned SDP/ICE messages, issues short-lived coturn credentials, and stores only identity/session data in PostgreSQL. Caddy, the application server, PostgreSQL, and coturn run from one Docker Compose project; media prefers direct P2P and falls back only to the self-hosted TURN relay.

**Tech Stack:** pnpm workspaces, TypeScript, Node.js 24, Fastify, `@fastify/websocket`, `ws`, Zod, Drizzle ORM, PostgreSQL, Argon2id, JOSE, Electron, React, native WebRTC, Vitest, Playwright, Docker Compose, Caddy, coturn.

---

## Source of Truth

- Approved design: `docs/plans/2026-07-16-two-person-p2p-rtc-design.md`
- Historical multiplayer design: `docs/plans/2026-07-15-self-hosted-rtc-design.md`
- Historical multiplayer plan: `docs/plans/2026-07-15-self-hosted-rtc-implementation.md`

The new design supersedes the historical plan for the current MVP. Keep the mediasoup lab as a hardware/codec research tool; do not import mediasoup objects or SFU signaling into `apps/server` or `apps/desktop`.

## Execution Rules

- Use @superpowers:test-driven-development for every behavior change.
- Use @superpowers:systematic-debugging for every failing test, unexpected media result, or Docker networking failure.
- Use @superpowers:verification-before-completion before every task-completion claim.
- Use @superpowers:requesting-code-review after Tasks 10, 13, 15, and 16.
- Keep commits scoped to one task. Do not mix existing media-lab evidence with new product code.
- Do not add Redis, RustFS, mediasoup, contacts, camera, text chat, recording, system-audio capture, or mobile UI to this plan.
- Do not weaken 1080p60. Core product work may proceed before the two-device quality gate passes, but no platform may be called 1080p60-certified without Task 17 evidence.
- Do not pass the long-lived access JWT in a WebSocket URL. Exchange it over HTTPS for a single-use, short-lived signaling ticket.
- All protocol inputs are parsed with Zod at the trust boundary. Do not relay unparsed SDP/ICE payloads.
- All temporary-room clocks and randomness are injectable in unit tests.

## Existing Baseline

- Task 1 complete: monorepo, Git, lint, typecheck, test, and build baseline.
- Task 2 complete: versioned envelope, SFU-era schemas, server-config validator, and tests.
- Task 3 tooling complete but quality gate failed: the Windows lab has reusable H.264, capture, single-layer encoding, bitrate, and stats evidence; the same-host receiver-presentation gate did not pass and macOS is not certified.
- The current worktree contains verified but uncommitted Task 3 hardening. Task 4 preserves it before product work begins.

### Task 4: Freeze the Media-Lab Baseline and Failed Gate Evidence

**Files:**
- Modify: `apps/media-lab-desktop/src/main/index.ts`
- Modify: `apps/media-lab-desktop/src/renderer/src/codec.ts`
- Modify: `apps/media-lab-desktop/src/renderer/src/main.ts`
- Modify: `apps/media-lab-desktop/src/renderer/src/media-flow.ts`
- Modify: `apps/media-lab-desktop/test/*.test.ts`
- Modify: `apps/media-lab-server/src/worker.ts`
- Modify: `apps/media-lab-server/test/worker.test.ts`
- Modify: `packages/media-policy/src/screen-encoding.ts`
- Modify: `packages/media-policy/src/stats.ts`
- Modify: `packages/media-policy/test/*.test.ts`
- Create: `docs/poc/hardware-gate-harness.mjs`
- Create: `docs/poc/hardware-gate-policy.mjs`
- Create: `docs/poc/hardware-gate-motion-source/*`
- Create: `tests/hardware-gate-policy.test.mjs`
- Modify: `docs/poc/1080p60-matrix.md`
- Modify: `docs/plans/2026-07-15-self-hosted-rtc-design.md`
- Modify: `docs/plans/2026-07-15-self-hosted-rtc-implementation.md`
- Modify: `eslint.config.mjs`

**Step 1: Confirm only the known Task 3 files are dirty**

Run:

```powershell
git status --short
git diff --stat
```

Expected: only the files listed above are dirty or untracked; the two-person design and this implementation plan are already committed separately.

**Step 2: Run the complete baseline verification**

Run:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
git diff --check
```

Expected: every command exits 0. The integration command may report no integration test files at this stage.

**Step 3: Verify the gate is recorded as failed, not certified**

Run:

```powershell
$summary = Get-Content -Raw docs/poc/results/runs/source-single-h264-preflight-8-final-gate/summary.json | ConvertFrom-Json
$summary.status
$summary.hardwarePass
```

Expected:

```text
GATE_FAILED
False
```

Check that documentation says the receiver presentation threshold failed, the run was same-host and window-source only, and macOS plus two-device 600-second evidence remain outstanding.

**Step 4: Commit only the Task 3 baseline**

```powershell
git add apps/media-lab-desktop apps/media-lab-server packages/media-policy docs/poc docs/plans/2026-07-15-self-hosted-rtc-design.md docs/plans/2026-07-15-self-hosted-rtc-implementation.md eslint.config.mjs tests/hardware-gate-policy.test.mjs
git diff --cached --check
git commit -m "test: add reproducible 1080p60 hardware gate"
```

Expected: one commit containing the lab and evidence hardening, with no claim that Task 3 quality certification passed.

### Task 5: Define the Active Two-Person P2P Protocol

**Files:**
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/auth.ts`
- Modify: `packages/protocol/src/room.ts`
- Create: `packages/protocol/src/webrtc.ts`
- Modify: `packages/protocol/src/media.ts`
- Modify: `packages/protocol/src/errors.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/protocol.test.ts`

**Step 1: Write failing room, WebRTC, and HTTP-auth schema tests**

Add focused cases to `packages/protocol/test/protocol.test.ts`:

```ts
test('accepts only six ASCII digits as a public room code', () => {
  expect(roomCodeSchema.safeParse('012345').success).toBe(true);
  expect(roomCodeSchema.safeParse('12345').success).toBe(false);
  expect(roomCodeSchema.safeParse('１２３４５６').success).toBe(false);
});

test('accepts a bounded browser ICE candidate and end-of-candidates', () => {
  expect(
    iceCandidateInitSchema.parse({
      candidate: 'candidate:1 1 udp 2122260223 host.local 55000 typ host',
      sdpMid: '1',
      sdpMLineIndex: 1,
      usernameFragment: 'abc',
    }),
  ).toBeDefined();
  expect(iceCandidateInitSchema.parse(null)).toBeNull();
});

test('rejects SFU transport messages from the active P2P union', () => {
  expect(
    p2pRequestEnvelopeSchema.safeParse({
      version: 1,
      requestId: 'request-1',
      type: 'transport.create',
      payload: { roomId: 'room-1', direction: 'send' },
    }).success,
  ).toBe(false);
});
```

Also cover register/login/refresh/logout bodies, `room.create/join/resume/leave/end`, `peer.ready`, offer, answer, ICE restart, stale negotiation IDs, screen owner broadcasts, unexpected fields, oversized SDP/candidate strings, and all ack/broadcast unions.

**Step 2: Run the protocol tests to verify failure**

Run:

```powershell
pnpm --filter @wo/protocol test
```

Expected: FAIL because the P2P schemas and unions do not exist.

**Step 3: Add stable user/connection IDs and HTTP auth contracts**

In `envelope.ts`, add branded `userIdSchema`, `connectionIdSchema`, and `negotiationIdSchema` using the existing bounded-identifier helper.

In `auth.ts`, keep the existing refresh envelope exported for historical compatibility, and add strict HTTPS body/response schemas:

```ts
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128);

export const authRegisterBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100),
  })
  .strict();

export const authLoginBodySchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
```

The public auth response contains the user, access token, refresh token, and access-token expiry seconds. It never contains a password hash or internal credential row ID.

**Step 4: Add room lifecycle contracts**

Define the public room code separately from the internal room ID:

```ts
export const roomCodeSchema = z.string().regex(/^\d{6}$/);
export const roomRoleSchema = z.enum(['creator', 'joiner']);
export const roomStateSchema = z.enum([
  'waiting',
  'negotiating',
  'connected',
  'reconnecting',
  'closed',
]);
```

Add strict request/ack/broadcast schemas for create, join by code, resume by internal ID, leave, end, peer ready, peer joined, peer left, and room closed. Successful create, join, and resume acks each return the internal room ID, role, peer summary, room state, the caller's current connection epoch, and freshly issued sanitized `RTCConfiguration` data plus credential expiry. This guarantees the creator has an ICE/TURN configuration path before the first offer without exposing the server secret.

**Step 5: Add browser-native WebRTC relay contracts**

Create `webrtc.ts` with bounded session descriptions and browser candidate-init data:

```ts
export const offerDescriptionSchema = z
  .object({
    type: z.literal('offer'),
    sdp: z.string().min(1).max(262_144),
  })
  .strict();

export const answerDescriptionSchema = z
  .object({
    type: z.literal('answer'),
    sdp: z.string().min(1).max(262_144),
  })
  .strict();

export const browserIceCandidateSchema = z
  .object({
    candidate: z.string().max(8_192),
    sdpMid: z.string().max(32).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(32).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export const iceCandidateInitSchema = browserIceCandidateSchema.nullable();
```

Every offer, answer, candidate, ICE-restart request, and ICE-server refresh includes `roomId`, `negotiationId`, and the sender's `connectionEpoch`. Epochs are monotonic per bound user slot, not global to the room, so one peer reconnecting does not invalidate the healthy peer's socket. The server uses the trusted socket's current per-user epoch to reject replayed signaling from an older connection. Define `webrtc.restartRequested` so the joiner can ask the creator to restart, `webrtc.iceServers.refresh` so both peers can obtain new short-lived credentials before a restart, and server-only `webrtc.negotiationReset` so resumed peers discard an incomplete negotiation and use the supplied new negotiation ID.

**Step 6: Adapt screen messages and active unions**

Keep the existing acquire/renew/release shapes and target-bitrate bounds. The active P2P mutation name is `screen.bitrate`, matching the approved design; keep legacy `screen.setTargetBitrate` only as a historical standalone export. Add `screen.ownerChanged` with nullable owner and lease expiry. Remove SFU transport/Producer/Consumer messages from the active `p2pRequestEnvelopeSchema`, `p2pAckEnvelopeSchema`, and `p2pBroadcastEnvelopeSchema`; keep their standalone schemas exported only for historical lab compatibility.

Add error codes for invalid credentials, auth required, room code invalid/expired, room closed, stale connection, stale negotiation, rate limited, and signaling unavailable. Remove `MEDIA_NODE_UNAVAILABLE` only from the active P2P behavior; retaining the legacy enum member is acceptable if old tests require it.

**Step 7: Run focused and full verification**

Run:

```powershell
pnpm --filter @wo/protocol test
pnpm --filter @wo/protocol typecheck
pnpm lint
```

Expected: all protocol tests pass and TypeScript prevents a mediasoup transport request from being assigned to the P2P request type.

**Step 8: Commit**

```powershell
git add packages/protocol
git commit -m "feat: define two-person p2p protocol"
```

### Task 6: Add Minimal P2P Server Configuration

**Files:**
- Create: `packages/config/src/internal/validation.ts`
- Create: `packages/config/src/p2p-server.ts`
- Modify: `packages/config/src/server.ts`
- Modify: `packages/config/src/index.ts`
- Create: `packages/config/test/p2p-server.test.ts`
- Modify: `packages/config/test/server.test.ts`
- Create: `deploy/.env.example`

**Step 1: Write failing P2P configuration tests**

Create a valid minimal environment fixture containing only:

```ts
const validP2pEnv = {
  NODE_ENV: 'test',
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: '3000',
  PUBLIC_URL: 'https://rtc.example.test',
  DATABASE_URL: 'postgres://wo:secret@127.0.0.1:5432/wo',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  TURN_SHARED_SECRET: 'test-turn-secret-at-least-32-characters',
  TURN_REALM: 'rtc.example.test',
  TURN_HOST: 'turn.example.test',
  TURN_URLS:
    'stun:turn.example.test:3478,turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp',
  TURN_CREDENTIAL_TTL_SECONDS: '600',
  ROOM_CODE_TTL_SECONDS: '600',
  ROOM_DISCONNECT_GRACE_SECONDS: '120',
  SCREEN_LEASE_TTL_SECONDS: '15',
  SCREEN_BITRATE_MIN: '1000000',
  SCREEN_BITRATE_MAX: '10000000',
};
```

Assert that Redis, RustFS, and mediasoup variables are not required; production rejects HTTP, loopback URLs, placeholder secrets, non-STUN/TURN schemes, invalid TTLs, reversed bitrate ranges, and duplicate TURN URLs.

**Step 2: Run tests to verify failure**

Run:

```powershell
pnpm --filter @wo/config test -- p2p-server
```

Expected: FAIL because `parseP2pServerConfig` does not exist.

**Step 3: Extract shared validation without changing legacy behavior**

Move the reusable URL, integer, production-secret, loopback, issue, and required-string helpers from `server.ts` into `src/internal/validation.ts`. Re-run the existing 84 legacy config tests before adding new behavior.

Run:

```powershell
pnpm --filter @wo/config test -- server
```

Expected: all legacy tests still pass.

**Step 4: Implement and deeply freeze `P2pServerConfig`**

Expose a separate parser rather than weakening the historical SFU parser:

```ts
export type P2pServerConfig = Readonly<{
  nodeEnv: NodeEnvironment;
  server: Readonly<{ host: string; port: number }>;
  publicUrl: string;
  database: Readonly<{ url: string }>;
  auth: Readonly<{ jwtAccessSecret: string }>;
  turn: Readonly<{
    sharedSecret: string;
    realm: string;
    host: string;
    urls: readonly string[];
    credentialTtlSeconds: number;
  }>;
  room: Readonly<{ codeTtlSeconds: number; disconnectGraceSeconds: number }>;
  screen: Readonly<{
    leaseTtlSeconds: number;
    bitrateRange: Readonly<{ min: number; max: number }>;
  }>;
}>;
```

Parse `TURN_URLS` as a bounded, de-duplicated list. This Compose version exposes non-TLS STUN/TURN on 3478, so allow only `stun:` and `turn:` and require every URL hostname to equal the separately configured `TURN_HOST`. Do not accept `stuns:`/`turns:` until the deployment publishes a reviewed TLS listener and certificate, and do not provide a public Google STUN default. Host equality verifies configuration consistency; deployment preflight and documentation still establish that the named host is operated by the deployer.

**Step 5: Add a non-secret environment template**

Create `deploy/.env.example` as the single deployment template with self-hosted placeholders and comments. Use `change-me` placeholders so the production parser demonstrably refuses an unedited file. Do not add any real credential or domain. Tasks 7 and 15 extend this same file when PostgreSQL and container-only fields are introduced; do not create a second root template.

**Step 6: Verify and commit**

Run:

```powershell
pnpm --filter @wo/config test
pnpm --filter @wo/config typecheck
pnpm format:check
pnpm lint
```

Expected: both legacy and P2P config suites pass.

```powershell
git add packages/config deploy/.env.example
git commit -m "feat: add p2p server configuration"
```

### Task 7: Add PostgreSQL Identity and Refresh-Session Persistence

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/tsconfig.build.json`
- Create: `packages/database/vitest.config.ts`
- Create: `packages/database/vitest.integration.config.ts`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/schema.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/src/identity-repository.ts`
- Create: `packages/database/src/session-repository.ts`
- Create: `packages/database/src/index.ts`
- Create: `packages/database/drizzle/0000_identity.sql`
- Create: `packages/database/test/schema.test.ts`
- Create: `packages/database/test/repositories.integration.test.ts`
- Create: `deploy/compose.test.yaml`

**Step 1: Scaffold the package and install database dependencies**

Create the package manifest with `build`, `test`, `test:integration`, `lint`, and `typecheck` scripts. Unit config includes only `test/**/*.test.ts` and excludes `*.integration.test.ts`; integration config includes only `test/**/*.integration.test.ts`. Then run:

```powershell
pnpm add --filter @wo/database drizzle-orm postgres
pnpm add -D --filter @wo/database drizzle-kit @types/node
```

Expected: the workspace lockfile records dependencies only for `@wo/database`.

**Step 2: Write failing schema and repository tests**

Define tests for stable users, provider-neutral identities, one password credential per user, unique normalized email identity, hashed refresh tokens, token-family rotation, reuse revocation, expiry, and disabled users.

Core expectations:

```ts
await repository.createEmailUser({
  userId: 'user-1',
  emailNormalized: 'person@example.com',
  displayName: 'Person',
  passwordHash: '$argon2id$redacted',
});

await expect(
  repository.createEmailUser({
    userId: 'user-2',
    emailNormalized: 'person@example.com',
    displayName: 'Other',
    passwordHash: '$argon2id$redacted',
  }),
).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
```

**Step 3: Run the unit test to verify failure**

Run:

```powershell
pnpm --filter @wo/database test
```

Expected: FAIL because the schema and repositories do not exist.

**Step 4: Implement the minimum schema and migration**

Create exactly these tables:

- `users`: `id`, `display_name`, `created_at`, `disabled_at`.
- `auth_identities`: `id`, `user_id`, `provider`, `identifier_normalized`, `verified_at`, unique `(provider, identifier_normalized)`.
- `password_credentials`: `user_id`, `password_hash`, `password_changed_at`.
- `refresh_sessions`: `id`, `user_id`, `family_id`, `token_hash`, `expires_at`, `rotated_at`, `revoked_at`, `created_at`, unique `token_hash`.

Use application-generated UUIDs and UTC timestamps. Do not store rooms, SDP, ICE, TURN credentials, device names, or media statistics in PostgreSQL.

**Step 5: Implement explicit repository transactions**

`createEmailUser()` inserts user, identity, and password credential in one transaction. `rotateRefreshSession()` locks the session row, marks the presented token rotated, creates its replacement, and revokes the whole family if a rotated token is presented again.

Return domain-safe records; never return the stored refresh-token hash outside the session repository.

**Step 6: Verify against a real PostgreSQL container**

Start only the test database:

```powershell
docker compose -f deploy/compose.test.yaml up -d --wait postgres
$env:TEST_DATABASE_URL='postgres://wo_test:wo_test@127.0.0.1:55432/wo_test'
pnpm --filter @wo/database test:integration
docker compose -f deploy/compose.test.yaml down -v
```

Expected: migration applies to an empty database, repository tests pass, and the unique identity constraint holds under concurrent inserts.

**Step 7: Run package verification and commit**

Run:

```powershell
pnpm --filter @wo/database test
pnpm --filter @wo/database typecheck
pnpm --filter @wo/database build
```

Expected: PASS.

```powershell
git add packages/database deploy/compose.test.yaml pnpm-lock.yaml
git commit -m "feat: add identity and session persistence"
```

### Task 8: Build the App Server and Email/Password Authentication

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/tsconfig.build.json`
- Create: `apps/server/vitest.config.ts`
- Create: `apps/server/vitest.integration.config.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/src/http/errors.ts`
- Create: `apps/server/src/http/authenticate.ts`
- Create: `apps/server/src/modules/auth/password.ts`
- Create: `apps/server/src/modules/auth/access-token.ts`
- Create: `apps/server/src/modules/auth/refresh-token.ts`
- Create: `apps/server/src/modules/auth/auth-service.ts`
- Create: `apps/server/src/modules/auth/auth-routes.ts`
- Create: `apps/server/src/modules/health/health-routes.ts`
- Create: `apps/server/test/password.test.ts`
- Create: `apps/server/test/auth-service.test.ts`
- Create: `apps/server/test/auth.integration.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Step 1: Scaffold the server and install explicit dependencies**

Create the package manifest, then run:

```powershell
pnpm add --filter @wo/server '@wo/config@workspace:*' '@wo/database@workspace:*' '@wo/protocol@workspace:*' fastify '@fastify/rate-limit' '@fastify/websocket' argon2 jose ws zod
pnpm add -D --filter @wo/server @types/node @types/ws
```

Add `argon2` to `onlyBuiltDependencies` in `pnpm-workspace.yaml`. Do not rely on the `ws` dependency owned by the lab package.

The server package scripts must include `dev` (watch-mode TypeScript runner loading the ignored `deploy/.env.local` through Node's env-file support), `build`, `start`, `test`, `test:integration`, `lint`, and `typecheck`; Task 12 relies on `pnpm --filter @wo/server dev` for the two-client manual check.

**Step 2: Write failing password and auth-service tests**

Test Argon2id hashing, password verification, generic invalid-login errors, disabled accounts, access-token claims, refresh-token hashing, rotation, logout, and token-family reuse detection.

```ts
test('stores an Argon2id hash rather than the password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(hash).not.toContain('correct horse');
  await expect(
    verifyPassword(hash, 'correct horse battery staple'),
  ).resolves.toBe(true);
});
```

**Step 3: Run focused tests to verify failure**

Run:

```powershell
pnpm --filter @wo/server test -- password auth-service
```

Expected: FAIL because the server auth modules do not exist.

**Step 4: Implement password, access-token, and refresh-token primitives**

- Hash with Argon2id and explicit memory/time/parallelism parameters tested in the production container.
- Sign 15-minute access JWTs with `sub`, `sessionId`, `iat`, `exp`, `iss`, and `aud` using `jose`.
- Generate 32-byte random opaque refresh tokens and store only SHA-256 hashes.
- Rotate refresh tokens transactionally. On reuse, revoke the family and return a generic reauthentication error.
- Never log raw email, password, JWT, refresh token, or hash.

**Step 5: Write failing route integration tests**

Cover:

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/health/live`
- `GET /v1/health/ready`

Assert strict request parsing, normalized email, duplicate identity conflict, generic wrong-password response, refresh rotation, revoked logout token, request-size limits, and rate limits.

**Step 6: Implement the Fastify app and routes**

Build `createApp(dependencies)` for tests and keep `index.ts` limited to config loading, database startup/migration, signal handling, listen, and idempotent shutdown.

Register a single JSON error mapper. Authentication middleware verifies the bearer access token and attaches trusted `userId` and `sessionId`; routes never read identity from request bodies.

**Step 7: Run unit and real-database integration tests**

Run:

```powershell
docker compose -f deploy/compose.test.yaml up -d --wait postgres
$env:TEST_DATABASE_URL='postgres://wo_test:wo_test@127.0.0.1:55432/wo_test'
pnpm --filter @wo/server test
pnpm --filter @wo/server test:integration -- auth
pnpm --filter @wo/server typecheck
docker compose -f deploy/compose.test.yaml down -v
```

Expected: all auth tests pass; a rotated token cannot be reused and a logged-out token cannot refresh.

**Step 8: Commit**

```powershell
git add apps/server pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: add email password authentication"
```

### Task 9: Implement the In-Memory Two-Person Room Domain

**Files:**
- Create: `apps/server/src/modules/rooms/room-types.ts`
- Create: `apps/server/src/modules/rooms/room-code.ts`
- Create: `apps/server/src/modules/rooms/room-registry.ts`
- Create: `apps/server/src/modules/rooms/join-attempt-limiter.ts`
- Create: `apps/server/test/room-code.test.ts`
- Create: `apps/server/test/room-registry.test.ts`
- Create: `apps/server/test/join-attempt-limiter.test.ts`

**Step 1: Write failing deterministic room-code tests**

Inject randomness rather than mocking Node globally:

```ts
test('pads a cryptographically supplied number to six digits', () => {
  expect(generateRoomCode({ randomInt: () => 42 })).toBe('000042');
});

test('retries a collision without replacing the existing room', () => {
  const values = [42, 42, 43];
  const registry = createRegistry({
    randomInt: () => values.shift()!,
    now: () => 0,
  });
  expect(registry.create('creator-1').code).toBe('000042');
  expect(registry.create('creator-2').code).toBe('000043');
});
```

**Step 2: Write failing lifecycle and capacity tests**

Cover:

- a code expires after the configured 10 minutes;
- creator and joiner must be different user IDs;
- the first successful join binds the second account and consumes the public code;
- the same bound account can resume but a third account reusing the consumed code receives the same generic `ROOM_CODE_INVALID` result as an expired or nonexistent code;
- each bound account has at most one active WSS connection; a successful resume atomically replaces and closes its older socket, releases any connection-bound screen lease, and advances only that account's current epoch;
- disconnect handling always supplies the closing socket's connection ID and epoch and uses compare-and-disconnect; a delayed close from a replaced socket may clean only its own resources and must not mark the replacement offline, start room grace, or remove the new connection;
- disconnecting one peer keeps the room resumable while the other remains online;
- both peers disconnected starts the configured two-minute grace;
- resume before expiry cancels cleanup;
- creator end closes immediately and cleanup is idempotent;
- service restart means a new registry has no rooms;
- repeated request IDs return the same result without repeating state changes.

**Step 3: Run focused tests to verify failure**

Run:

```powershell
pnpm --filter @wo/server test -- room-code room-registry join-attempt-limiter
```

Expected: FAIL because the room domain does not exist.

**Step 4: Implement a small explicit state model**

Use one record per room:

```ts
type TemporaryRoom = {
  readonly id: string;
  readonly creatorUserId: string;
  joinerUserId: string | null;
  code: string | null;
  codeExpiresAtMs: number;
  state: 'waiting' | 'negotiating' | 'connected' | 'reconnecting';
  readonly connectionsByUserId: Map<string, PeerConnectionState>;
  nextConnectionEpoch: number;
  readonly currentConnectionEpochByUserId: Map<string, number>;
  activeNegotiation: RoomNegotiationState | null;
  closeAtMs: number | null;
};
```

Keep all maps private. Expose methods returning immutable snapshots, not live maps. Use injected `now`, `randomInt`, `randomUUID`, `setTimer`, and `clearTimer` dependencies. Serialize mutations on the JavaScript event loop; do not introduce Redis or database rows.

`RoomNegotiationState` is room-scoped and contains one negotiation ID, offerer user ID, and the expected current epoch for each bound user. Replacing B's socket advances only B's stored epoch; A's still-current epoch and socket remain valid. If any offer/answer negotiation is in flight, replacement marks it abandoned and creates a reset generation rather than rewriting its epoch snapshot or attempting to replay SDP.

**Step 5: Implement bounded join-attempt limiting**

Track attempts by trusted user ID plus normalized remote IP. Bound map size and prune expired entries. The room-code error response is deliberately generic for nonexistent, expired, and already-consumed codes; internal logs use only an anonymized user ID and request ID.

**Step 6: Verify timers, concurrency, and leaks**

Use fake timers to create and expire at least 1,000 rooms. Assert the registry, code index, idempotency cache, and timers return to zero after cleanup.

Run:

```powershell
pnpm --filter @wo/server test -- room
pnpm --filter @wo/server typecheck
```

Expected: PASS with no pending fake timers.

**Step 7: Commit**

```powershell
git add apps/server/src/modules/rooms apps/server/test/room-code.test.ts apps/server/test/room-registry.test.ts apps/server/test/join-attempt-limiter.test.ts
git commit -m "feat: add temporary two-person rooms"
```

### Task 10: Add Authenticated WSS Signaling and Self-Hosted TURN Credentials

**Files:**
- Create: `apps/server/src/modules/signaling/signal-ticket-store.ts`
- Create: `apps/server/src/modules/signaling/signal-ticket-routes.ts`
- Create: `apps/server/src/modules/signaling/connection-registry.ts`
- Create: `apps/server/src/modules/signaling/gateway.ts`
- Create: `apps/server/src/modules/signaling/dispatcher.ts`
- Create: `apps/server/src/modules/signaling/handlers/room.ts`
- Create: `apps/server/src/modules/signaling/handlers/webrtc.ts`
- Create: `apps/server/src/modules/turn/credentials.ts`
- Create: `apps/server/src/modules/turn/ice-servers.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/signal-ticket-store.test.ts`
- Create: `apps/server/test/turn-credentials.test.ts`
- Create: `apps/server/test/signaling.integration.test.ts`

**Step 1: Write failing single-use signaling-ticket tests**

The browser WebSocket API cannot attach the normal bearer header, so use a one-use ticket:

```ts
const ticket = store.issue({ userId: 'user-1', sessionId: 'session-1' });
expect(store.consume(ticket.value)).toMatchObject({ userId: 'user-1' });
expect(store.consume(ticket.value)).toBeNull();
clock.advanceBy(31_000);
expect(store.consume(store.issueForTestBeforeAdvance().value)).toBeNull();
```

Use 32 random bytes, a 30-second TTL, constant-time hash comparison where applicable, bounded storage, and no raw-ticket logging.

**Step 2: Write failing TURN credential tests**

Given a fixed clock and secret, assert the coturn REST credential exactly matches HMAC-SHA1 over the expiring username:

```ts
const result = createTurnCredentials({
  roomId: 'room-1',
  userId: 'user-1',
  connectionEpoch: 3,
  nowSeconds: 1_700_000_000,
  ttlSeconds: 600,
  secret: 'test-turn-secret',
});

expect(result.username).toMatch(/^1700000600:[A-Za-z0-9_-]{22}$/);
expect(result.username).not.toContain('room-1');
expect(result.username).not.toContain('user-1');
expect(result.credential).toBe(
  createHmac('sha1', 'test-turn-secret')
    .update(result.username)
    .digest('base64'),
);
```

The opaque suffix is a domain-separated HMAC of room ID, user ID, and connection epoch, never a raw internal ID. Assert returned ICE servers contain only configured self-hosted URLs, have no shared secret, and expire within the configured TTL. Also assert an authenticated user cannot request/refresh ICE credentials for a room to which they are not currently bound. The opaque username scopes issuance and logs; coturn itself does not understand application rooms, so do not claim it can prevent a valid credential from relaying arbitrary WebRTC packets during its TTL.

**Step 3: Write failing WebSocket integration tests**

Against `createApp()` on an ephemeral port, cover:

- access bearer token exchanges for `POST /v1/realtime/ticket`;
- ticket is consumed once from a `ticket.<base64url>` entry in `Sec-WebSocket-Protocol` during the query-free `/v1/realtime` upgrade, while the server selects `wo-v1` as the negotiated application subprotocol;
- missing, expired, or replayed ticket is rejected;
- binary frames and payloads above 1 MiB are rejected;
- malformed or unsupported protocol envelopes return normalized errors;
- create, join, resume, leave, end, and peer-ready handlers use trusted socket identity;
- only the creator sends the initial offer;
- offer, answer, candidates, end-of-candidates, and ICE restart relay only to the bound peer;
- create, join, and resume acks each contain fresh ICE configuration, and `webrtc.iceServers.refresh` is authorized only for a current room peer;
- wrong room, stale connection epoch, stale negotiation ID, and third-user relay attempts are rejected;
- resuming from a second socket for the same bound account closes the old socket, rejects all later old-epoch frames, and leaves the healthy peer's epoch valid;
- the replaced socket closes with application code `4409` and reason `SESSION_REPLACED`; its later close callback fails compare-and-disconnect and cannot remove the replacement;
- disconnect/resume after a lost initial offer, lost initial answer, or lost ICE-restart answer abandons the old negotiation and broadcasts exactly one `webrtc.negotiationReset` with a new ID after both peers are ready;
- duplicate request ID returns the cached ack once without duplicate broadcast;
- ping/pong heartbeat terminates a half-open socket after two missed intervals;
- socket close updates the room and broadcasts `peer.left`;
- excessive buffered output closes a slow connection rather than growing memory without bound.

**Step 4: Run focused tests to verify failure**

Run:

```powershell
pnpm --filter @wo/server test -- signal-ticket turn-credentials
pnpm --filter @wo/server test:integration -- signaling
```

Expected: FAIL because the signaling gateway and TURN helpers do not exist.

**Step 5: Implement the ticket route and TURN response**

The ticket route requires normal bearer authentication. It returns only `{ ticket, expiresInSeconds }`. The WebSocket upgrade consumes the ticket from the offered subprotocol list before accepting application messages. Never put the access token or signaling ticket in the URL. Configure application/Caddy logging and tests so handshake failures do not record the raw `Sec-WebSocket-Protocol` header; every retry obtains a new ticket.

Generate sanitized ICE configuration per authenticated peer:

```ts
type PublicIceServer = Readonly<{
  urls: readonly string[];
  username?: string;
  credential?: string;
}>;
```

STUN-only URLs have no credentials. TURN URLs use the generated short-lived username and credential.

**Step 6: Implement the versioned signaling gateway**

Register Fastify's WebSocket plugin before every route, then use it with `ws`. The `wsHandler` synchronously attaches `message`, `error`, `close`, and `pong` listeners before performing async work; every async message path catches and normalizes its own errors because the HTTP error handler does not handle WebSocket callback failures.

Use:

- `maxPayload: 1_048_576`;
- text frames only;
- Zod parsing before dispatch;
- one connection ID plus an epoch from the room's monotonic counter, stored as the current epoch only for that bound user;
- a bounded per-connection request-ID ack cache;
- a bounded outbound-buffer threshold;
- a server-driven ping/pong heartbeat with timers cleared on every close path;
- idempotent close and room cleanup.

The server forwards parsed, reconstructed messages. It never forwards the original raw JSON object. Custom close code `4409 SESSION_REPLACED` is reserved for an atomically superseded same-account socket; it is not used for transient network failure.

**Step 7: Implement room and WebRTC handlers**

Room handlers call `RoomRegistry`; they do not duplicate room state. They issue fresh ICE configuration in every create/join/resume ack so the creator can offer immediately. WebRTC handlers enforce:

- role-based initial offerer;
- one active negotiation ID with the expected current epoch for each participant;
- `answer` only after a valid offer;
- trickle candidates only for the current negotiation;
- ICE-server refresh only for the trusted socket's active room binding;
- ICE restart creates a new negotiation ID;
- no SDP or candidate is persisted or logged.

**Step 8: Verify the complete server**

Run:

```powershell
pnpm --filter @wo/server test
pnpm --filter @wo/server test:integration
pnpm --filter @wo/server typecheck
pnpm --filter @wo/server build
pnpm lint
```

Expected: all auth, room, ticket, TURN, and signaling tests pass.

**Step 9: Request code review and commit**

Use @superpowers:requesting-code-review, fix all P0-P2 findings, repeat Step 8, then:

```powershell
git add apps/server
git commit -m "feat: add authenticated p2p signaling"
```

### Task 11: Build the Secure Electron Shell and Account/Room UI

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/tsconfig.web.json`
- Create: `apps/desktop/src/main/index.ts`
- Create: `apps/desktop/src/main/window-security.ts`
- Create: `apps/desktop/src/main/runtime-config.ts`
- Create: `apps/desktop/src/main/secure-session-store.ts`
- Create: `apps/desktop/src/main/auth-session-broker.ts`
- Create: `apps/desktop/src/main/realtime-ticket-broker.ts`
- Create: `apps/desktop/src/main/ipc.ts`
- Create: `apps/desktop/src/preload/api.ts`
- Create: `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/preload/types.ts`
- Create: `apps/desktop/src/renderer/index.html`
- Create: `apps/desktop/src/renderer/src/env.d.ts`
- Create: `apps/desktop/src/renderer/src/main.tsx`
- Create: `apps/desktop/src/renderer/src/App.tsx`
- Create: `apps/desktop/src/renderer/src/api/http-client.ts`
- Create: `apps/desktop/src/renderer/src/state/auth-store.tsx`
- Create: `apps/desktop/src/renderer/src/state/room-store.tsx`
- Create: `apps/desktop/src/renderer/src/routes/AuthRoute.tsx`
- Create: `apps/desktop/src/renderer/src/routes/HomeRoute.tsx`
- Create: `apps/desktop/src/renderer/src/routes/RoomRoute.tsx`
- Create: `apps/desktop/src/renderer/src/components/CallToolbar.tsx`
- Create: `apps/desktop/src/renderer/src/components/ParticipantSlots.tsx`
- Create: `apps/desktop/src/renderer/src/styles.css`
- Create: `apps/desktop/test/security.test.ts`
- Create: `apps/desktop/test/preload-api.test.ts`
- Create: `apps/desktop/test/secure-session-store.test.ts`
- Create: `apps/desktop/test/auth-session-broker.test.ts`
- Create: `apps/desktop/test/realtime-ticket-broker.test.ts`
- Create: `apps/desktop/test/app.test.tsx`
- Modify: `pnpm-lock.yaml`

**Step 1: Scaffold the product app and install UI/test dependencies**

Do not rename or copy the entire media lab. Create a separate product package, then run:

```powershell
pnpm add --filter @wo/desktop '@wo/media-policy@workspace:*' '@wo/protocol@workspace:*' lucide-react react react-dom
pnpm add -D --filter @wo/desktop @testing-library/react @testing-library/user-event @types/node @types/react @types/react-dom electron@43.1.1 electron-vite@5.0.0 jsdom vite
```

Pin Electron to the same tested version as the lab until Task 16 deliberately upgrades it.

**Step 2: Write failing Electron security tests**

Assert:

```ts
expect(windowOptions.webPreferences).toMatchObject({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
});
```

Also assert navigation and `window.open` are denied, production certificates are never bypassed, renderer URLs are local packaged assets or the exact development origin, CSP blocks remote scripts/fonts, and every IPC channel is explicitly allowlisted and argument-validated. Every auth/realtime IPC handler verifies `event.senderFrame` is the main frame at the exact application origin.

**Step 3: Write failing secure-session tests**

Model Electron `safeStorage` and filesystem dependencies. Cover unavailable encryption, atomic encrypted write, read/decrypt, corrupted ciphertext, logout deletion, and file permission failure.

The renderer API must not expose a method that returns a refresh token:

```ts
expect(Object.keys(window.desktop.auth)).toEqual([
  'register',
  'login',
  'refresh',
  'logout',
]);
expect(JSON.stringify(window.desktop)).not.toContain('getRefreshToken');
```

**Step 4: Implement the secure BrowserWindow and preload boundary**

Reuse the lab's security pattern, not its development certificate exception. Enable app sandboxing before ready, enforce navigation policy, and expose only immutable typed methods.

Use Electron `safeStorage` in the main process. Store only encrypted refresh-token ciphertext under `app.getPath('userData')`; fail closed on Windows/macOS if OS encryption is unavailable. Never place refresh tokens in renderer memory, localStorage, query strings, logs, or crash context.

For development/E2E only, `runtime-config.ts` accepts a validated `WO_DEV_PROFILE` and assigns an isolated user-data directory before app ready. Production builds ignore this variable. This allows two local clients without sharing refresh ciphertext or Electron storage.

**Step 5: Implement the main-process auth and realtime brokers**

Registration and login HTTP calls run in the main process. The broker stores the returned refresh token and returns only user, access token, and expiry to the renderer. Refresh reads the encrypted token, rotates it through HTTPS, atomically replaces ciphertext, and returns the new access token. Logout clears local ciphertext even if the network call fails.

All main-process auth fetches use one immutable, startup-validated HTTPS API origin, set `redirect: 'error'`, apply bounded timeouts/body sizes, and reject any response whose final origin differs. The realtime broker accepts the renderer's in-memory access token, calls `POST /v1/realtime/ticket` at that same origin, and returns only the short-lived single-use ticket. Packaged `file://` renderer code never fetches the API directly, so CORS is not part of the auth/ticket boundary.

**Step 6: Write failing UI workflow tests**

Test register/login validation, loading/error states, create-room, join-by-six-digit-code, waiting for peer, two fixed participant slots, room-full/expired errors, logout, and room close. Mock only the typed preload and signaling boundaries.

**Step 7: Build the operational UI**

The first screen is auth, followed by one compact home surface with “创建房间” and a six-digit join input. The room view contains two stable participant slots, an unframed screen stage, connection status, and a fixed bottom toolbar. Use Lucide icons with tooltips for mute, share, settings, and hangup. Do not add landing-page copy, nested cards, contacts, camera, chat, or feature tutorials.

Ensure 920x640 desktop minimum and narrower responsive layouts do not overlap or resize controls when state labels change.

**Step 8: Verify and commit**

Run:

```powershell
pnpm --filter @wo/desktop test
pnpm --filter @wo/desktop typecheck
pnpm --filter @wo/desktop lint
pnpm --filter @wo/desktop build
```

Expected: security, preload, storage, auth/realtime broker, and UI tests pass; production build contains no remote asset requests.

```powershell
git add apps/desktop pnpm-lock.yaml
git commit -m "feat: add secure desktop application shell"
```

### Task 12: Add One PeerConnection and Bidirectional Voice

**Files:**
- Create: `apps/desktop/src/renderer/src/media/signaling-client.ts`
- Create: `apps/desktop/src/renderer/src/media/transceiver-plan.ts`
- Create: `apps/desktop/src/renderer/src/media/peer-connection-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/negotiation-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/voice-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/audio-output.ts`
- Create: `apps/desktop/src/renderer/src/media/media-cleanup.ts`
- Create: `apps/desktop/src/renderer/src/state/call-store.tsx`
- Create: `apps/desktop/src/renderer/src/components/ConnectionStatus.tsx`
- Modify: `apps/desktop/src/renderer/src/routes/RoomRoute.tsx`
- Modify: `apps/desktop/src/renderer/src/components/CallToolbar.tsx`
- Create: `apps/desktop/test/signaling-client.test.ts`
- Create: `apps/desktop/test/transceiver-plan.test.ts`
- Create: `apps/desktop/test/peer-connection-controller.test.ts`
- Create: `apps/desktop/test/negotiation-controller.test.ts`
- Create: `apps/desktop/test/voice-controller.test.ts`
- Create: `apps/desktop/test/media-cleanup.test.ts`

**Step 1: Write failing typed signaling-client tests**

Cover ticket acquisition through the typed main/preload realtime broker, query-free WSS construction with offered subprotocols `wo-v1` and `ticket.<base64url>`, request ID/ack matching, timeout, broadcast dispatch, Zod rejection, protocol-version mismatch, pending-request rejection on close, bounded retries with a new ticket every time, and access-token refresh without putting either token in the URL.

**Step 2: Write failing transceiver and negotiation tests**

The creator creates exactly two transceivers before the first offer:

```ts
const audio = pc.addTransceiver('audio', { direction: 'sendrecv' });
const screen = pc.addTransceiver('video', {
  direction: 'sendrecv',
  sendEncodings: [
    {
      rid: 'f',
      active: true,
      maxBitrate: 8_000_000,
      scalabilityMode: 'L1T1',
      scaleResolutionDownBy: 1,
    },
  ],
});
```

Assert the creator alone calls `createOffer()`, refreshes ICE servers first when credentials are expired or have less than 120 seconds remaining, calls `setConfiguration()` with the refresh result before offering, the joiner answers the received offer, remote descriptions precede candidate application, candidates are buffered until then, and mute/device changes never call `createOffer()` or add a transceiver. Include a forced-TURN test where the joiner arrives 599 seconds after room creation: the stale create-ack credential is never used for the first offer.

After the creator successfully applies the current-generation answer with `setRemoteDescription()`, it sends one idempotent `webrtc.answerApplied` request. The server does not mark the negotiation completed before this acknowledgement. A timeout retries the same request ID; a stale promise from a reset or rebuilt controller generation must never send the acknowledgement.

For the joiner, obtain the two transceivers created by the remote offer after `setRemoteDescription()`, map them by stable media kind/MID, set both desired directions to `sendrecv`, attach the microphone before `createAnswer()`, and apply codec preferences before creating the answer. Do not create duplicate answer-side transceivers. Assert the resulting answer contains send capability for both m-lines so the joiner can later use the existing video sender.

**Step 3: Write failing voice-controller tests**

Mock `mediaDevices` and cover permission denial, these exact capture intents, one microphone track, mute/unmute, microphone hot-swap with `replaceTrack()`, remote track attachment, output mute, supported `setSinkId()`, unsupported output selection, and idempotent cleanup:

```ts
expect(getUserMedia).toHaveBeenCalledWith({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
});
```

**Step 4: Run tests to verify failure**

Run:

```powershell
pnpm --filter @wo/desktop test -- signaling-client transceiver-plan peer-connection negotiation voice media-cleanup
```

Expected: FAIL because the P2P media controllers do not exist.

**Step 5: Implement signaling and PeerConnection ownership**

One `PeerConnectionController` owns exactly one `RTCPeerConnection`, the two transceiver references, the current negotiation ID, its local connection epoch, the last accepted remote connection epoch, and cleanup. Use the sanitized ICE servers from the room ack. Do not import `mediasoup-client`, munge SDP, set `x-google-*`, or use a public STUN fallback.

Use `RTCRtpTransceiver.setCodecPreferences()` when supported to prefer Opus for audio and the platform policy's H.264 candidate for screen video; fall back to standards negotiation rather than editing SDP.

**Step 6: Implement voice publishing and playback**

Acquire the microphone only after explicit join/permission flow. Attach it with `audio.sender.replaceTrack(track)`. Use one owned audio element for the remote audio receiver track, and release elements, tracks, listeners, and senders exactly once on leave.

Track audio receiving continuity from WebRTC stats for diagnostics, but do not persist or upload audio data.

**Step 7: Integrate call state and controls**

Wire room join/ready into negotiation, render connecting/connected/relay/error state, and enable microphone selection, mute, output selection where supported, output mute, and hangup. Controls have fixed dimensions and remain operable while the peer reconnects.

**Step 8: Verify with two local app instances**

Create the ignored `deploy/.env.local` from the template with localhost/test secrets and the test database URL. Start the test PostgreSQL container, then use three separate terminals so the long-running dev commands do not block one another.

Terminal A:

```powershell
docker compose -f deploy/compose.test.yaml up -d --wait postgres
pnpm --filter @wo/server dev
```

Terminal B:

```powershell
$env:WO_DEV_PROFILE='left'
pnpm --filter @wo/desktop dev
```

Terminal C:

```powershell
$env:WO_DEV_PROFILE='right'
pnpm --filter @wo/desktop dev
```

Expected: the two isolated clients enter one room, exchange audio, mute independently, switch an available microphone, and leave without unhandled rejection or open media track. Stop the two dev processes and run `docker compose -f deploy/compose.test.yaml down -v` afterward.

**Step 9: Run automated verification and commit**

Run:

```powershell
pnpm --filter @wo/desktop test
pnpm --filter @wo/desktop typecheck
pnpm --filter @wo/desktop build
pnpm --filter @wo/server test
```

Expected: PASS.

```powershell
git add apps/desktop
git commit -m "feat: add two-person p2p voice"
```

### Task 13: Add Single Desktop Share and Runtime Bitrate Control

**Files:**
- Create: `apps/server/src/modules/screen/screen-lease-registry.ts`
- Create: `apps/server/src/modules/signaling/handlers/screen.ts`
- Modify: `apps/server/src/modules/signaling/dispatcher.ts`
- Create: `apps/server/test/screen-lease-registry.test.ts`
- Modify: `apps/server/test/signaling.integration.test.ts`
- Create: `apps/desktop/src/main/capture-policy.ts`
- Create: `apps/desktop/src/main/capture-sources.ts`
- Create: `apps/desktop/src/main/permissions.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/api.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Create: `apps/desktop/src/renderer/src/media/screen-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/sender-bitrate.ts`
- Create: `apps/desktop/src/renderer/src/components/SourcePicker.tsx`
- Create: `apps/desktop/src/renderer/src/components/ScreenShareToolbar.tsx`
- Create: `apps/desktop/src/renderer/src/components/ScreenStage.tsx`
- Modify: `apps/desktop/src/renderer/src/components/CallToolbar.tsx`
- Modify: `apps/desktop/src/renderer/src/routes/RoomRoute.tsx`
- Create: `apps/desktop/test/capture-policy.test.ts`
- Create: `apps/desktop/test/screen-controller.test.ts`
- Create: `apps/desktop/test/sender-bitrate.test.ts`

**Step 1: Write failing server lease tests**

Test one winner when both peers acquire simultaneously, holder-only renewal, exact lease-ID release, 5-second renewal cadence, 15-second expiry, disconnect cleanup, room-end cleanup, stale connection rejection, and reacquisition after expiry. Use the room registry's injected clock/timers; do not add Redis.

```ts
const [left, right] = await Promise.allSettled([
  leases.acquire({ roomId, userId: 'user-1', connectionId: 'left' }),
  leases.acquire({ roomId, userId: 'user-2', connectionId: 'right' }),
]);
expect([left, right].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
```

**Step 2: Write failing capture-policy and permission tests**

Port the lab's source allowlist into the product package; do not import across app boundaries. Test that only a freshly enumerated source ID can be selected, stale sources are cleared, renderer-supplied file paths are rejected, audio capture is rejected, and a request without a user gesture receives no source.

On macOS, test the states returned by `systemPreferences.getMediaAccessStatus('screen')` and the approved action for opening system settings. Never bypass the OS permission decision.

**Step 3: Write failing screen-controller tests**

Cover this exact ordering and cleanup:

1. acquire server lease;
2. start lease renewal immediately, before opening any picker;
3. enumerate and select source;
4. call `getDisplayMedia()` for video only;
5. inspect `track.getSettings()`;
6. require one final successful renewal immediately before attach;
7. `screen.sender.replaceTrack(track)`;
8. on stop or `track.onended`, `replaceTrack(null)`, stop track, cancel renewal, release lease.

Assert cancel, permission denial, capture failure, `replaceTrack` failure, signaling disconnect, lease-renewal timeout, explicit `LEASE_LOST`, duplicate stop, and competing cleanup all stop the screen sender and release at most once. Add a fake-clock case where the picker remains open beyond the original TTL, the peer loses renewal, and the other peer acquires: the stale holder must fail its final renewal and must never call `replaceTrack(track)`. A renewal request must time out early enough to execute local `replaceTrack(null)` before the 15-second server lease can expire and be granted to the other peer. Starting or stopping share must not call `addTrack`, `addTransceiver`, `createOffer`, or recreate the PeerConnection.

**Step 4: Write failing sender-bitrate tests**

Adapt the lab behavior to a direct sender:

```ts
await setScreenBitrate(sender, { mode: 'fixed', bitrateBps: 4_000_000 });

expect(sender.setParameters).toHaveBeenCalledWith({
  transactionId: 'same-transaction',
  encodings: [{ ...currentEncoding, maxBitrate: 4_000_000 }],
});
```

Test automatic mode removes the explicit `maxBitrate`, fixed 2/4/6/8 Mbps presets, server-range clamping, sender rejection, an empty encodings array, one full-resolution encoding only, and rapid selections serialized so the final requested value wins. Every attempt calls `getParameters()` immediately before `setParameters()` and uses that current `transactionId`. An empty encoding array stores a pending target and waits for the transceiver to become running; it never inserts an encoding. A rejected update rolls the UI/last-successful target back without a second `setParameters()` call using stale parameters. After answer completion or PeerConnection rebuild, re-read current parameters and replay the pending/last successful target. No bitrate change may add/reorder encodings or trigger negotiation.

**Step 5: Run focused tests to verify failure**

Run:

```powershell
pnpm --filter @wo/server test -- screen-lease
pnpm --filter @wo/desktop test -- capture-policy screen-controller sender-bitrate
```

Expected: FAIL because the lease and product sharing modules do not exist.

**Step 6: Implement authoritative in-memory sharing ownership**

Store room ID, holder user ID, connection ID, random lease ID, expiry, and target bitrate. Validate current room binding on every operation. Broadcast `screen.ownerChanged` after acquire/release/expiry. A client bitrate notification records only the bounded target for peer UI and diagnostics; the server does not modify media. Because P2P media does not pass through the server, the product client must stop its local screen sender immediately when renewal cannot be acknowledged; do not imply that the server can forcibly remove a malicious peer's P2P track.

**Step 7: Implement secure source selection**

Use `desktopCapturer.getSources({ types: ['screen', 'window'] })`, sanitize source summaries, and return thumbnails but no process handle or filesystem path. `setDisplayMediaRequestHandler` returns only the source selected for that WebContents and only for a video-only user-gesture request.

Request ideal video constraints:

```ts
{
  audio: false,
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
  },
}
```

Show actual `track.getSettings()` rather than presenting requested values as achieved values.

**Step 8: Implement share controls and bitrate menu**

Provide screen/window thumbnails, start/stop, actual capture quality, and Auto/2/4/6/8 Mbps options. Either peer may share when the lease is idle. Disable the share action while the remote peer owns it. Keep controls stable in size and preserve voice controls during every screen state.

**Step 9: Verify the race and continuous audio behavior**

Run two clients, trigger share together, and confirm exactly one starts capture. During start, stop, owner exchange, and all bitrate changes, confirm the existing audio receiver continues increasing inbound audio counters and the negotiation count is unchanged.

Run:

```powershell
pnpm --filter @wo/server test
pnpm --filter @wo/server test:integration -- signaling
pnpm --filter @wo/desktop test
pnpm --filter @wo/desktop build
```

Expected: PASS.

**Step 10: Request code review and commit**

Use @superpowers:requesting-code-review, fix all P0-P2 findings, repeat Step 9, then:

```powershell
git add apps/server apps/desktop
git commit -m "feat: add adjustable single desktop share"
```

### Task 14: Add Reconnect, Cleanup, and Quality Diagnostics

**Files:**
- Create: `apps/desktop/src/renderer/src/state/call-machine.ts`
- Create: `apps/desktop/src/renderer/src/media/reconnect-controller.ts`
- Create: `apps/desktop/src/renderer/src/media/stats-monitor.ts`
- Create: `apps/desktop/src/renderer/src/media/stats-buffer.ts`
- Create: `apps/desktop/src/renderer/src/components/QualityPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ConnectionStatus.tsx`
- Modify: `apps/desktop/src/renderer/src/media/media-cleanup.ts`
- Modify: `apps/desktop/src/renderer/src/media/peer-connection-controller.ts`
- Modify: `apps/server/src/modules/rooms/room-registry.ts`
- Modify: `apps/server/src/modules/signaling/gateway.ts`
- Create: `apps/desktop/test/call-machine.test.ts`
- Create: `apps/desktop/test/reconnect-controller.test.ts`
- Create: `apps/desktop/test/stats-monitor.test.ts`
- Create: `apps/desktop/test/stats-buffer.test.ts`
- Modify: `apps/desktop/test/media-cleanup.test.ts`
- Modify: `apps/server/test/room-registry.test.ts`

**Step 1: Write failing call-state transition tests**

Allowed states are explicit:

```ts
type CallState =
  | 'idle'
  | 'joining'
  | 'waiting'
  | 'negotiating'
  | 'connected'
  | 'reconnecting-signal'
  | 'restarting-ice'
  | 'failed'
  | 'leaving';
```

Test every legal transition and reject stale async completions using a generation counter. `track-ended`, `lease-lost`, and screen-permission failure converge on idempotent share-only cleanup while voice and the call remain connected. Leave, room close, fatal peer failure, and app close converge on full-call cleanup. Never route a normal screen-stop event through full-call cleanup.

**Step 2: Write failing reconnect tests**

Cover:

- WSS drops while WebRTC remains connected: stop any active screen sender before its lease expires, keep voice media alive, acquire a new ticket, resume the room with the same bound account, and do not otherwise rebuild media;
- WSS closes with `4409 SESSION_REPLACED`: do not auto-resume; stop all local media and perform full-call cleanup so two devices on one account cannot enter a reconnect takeover loop;
- WSS drops during initial offer, initial answer, or an ICE-restart answer: the server abandons the in-flight negotiation because it stores no SDP, emits `webrtc.negotiationReset` after resume, both clients rebuild the PeerConnection while preserving only the valid microphone track, and the creator starts one new negotiation ID after both are ready;
- WSS drops after the creator applied the answer but before the `webrtc.answerApplied` ack returns: resume reports the completed negotiation, the client keeps a healthy PeerConnection, and an old-generation retry cannot complete a newer negotiation;
- ICE `disconnected`: wait a short grace before action;
- ICE `failed` on the creator: refresh ICE servers, call `setConfiguration()`, wait for `signalingState === 'stable'`, then call `restartIce()` (or `createOffer({ iceRestart: true })`) and send a new negotiation ID;
- ICE `failed` on the joiner: send one idempotent `webrtc.restartRequested`; the creator performs the restart, while duplicate/in-flight requests are coalesced and a bounded timeout fails visibly;
- restart answer/candidates from an old epoch are ignored;
- a restart request received during another negotiation is queued until stable rather than creating glare;
- failed restart stops and releases any active screen share, then rebuilds one PeerConnection while preserving the microphone track where valid and reapplying the last successful bitrate target only if sharing starts again;
- both peers disconnected past the server grace closes the room;
- server restart returns room closed and the UI returns to home with an explicit message.

**Step 3: Write failing stats and privacy tests**

Feed synthetic `RTCStatsReport` samples through `@wo/media-policy`. Assert bitrate/FPS baselines reset after ICE restart or selected candidate-pair change. Add presentation FPS from `HTMLVideoElement.getVideoPlaybackQuality()` or `requestVideoFrameCallback` counters.

Only expose route type and transport protocol:

```ts
expect(publicConnectionPath).toEqual({
  candidateType: 'relay',
  protocol: 'udp',
});
expect(JSON.stringify(publicConnectionPath)).not.toMatch(/192\.168\.|10\./);
```

Use a bounded ring buffer. Never record candidate IPs, SDP, email, window title, token, or source name in diagnostic export.

**Step 4: Run tests to verify failure**

Run:

```powershell
pnpm --filter @wo/desktop test -- call-machine reconnect stats media-cleanup
pnpm --filter @wo/server test -- room-registry
```

Expected: FAIL because recovery and diagnostics do not exist.

**Step 5: Implement signal resume and ICE restart separately**

Signaling recovery and media recovery are separate state-machine events. Do not tear down a healthy, stably negotiated PeerConnection merely because WSS reconnects. If the server marks the prior negotiation incomplete, discard buffered candidates/descriptions, stop/release screen sharing, rebuild the PeerConnection, and let only the creator offer with the reset negotiation ID; the server never attempts to replay SDP it did not persist. Before every ICE restart, both peers request fresh ICE servers through the active WSS message, apply them with `setConfiguration()`, and then follow the creator-offers/joiner-answers rule. Reset candidate and stats baselines on each accepted negotiation generation.

**Step 6: Implement scoped idempotent cleanup**

`cleanupShare()` cancels renewal, replaces only the screen sender with null, stops only the screen track, releases the lease when possible, and leaves microphone, remote audio, PeerConnection, and WSS alive.

`cleanupTransportForRebuild()` closes the old PeerConnection/listeners and remote elements but preserves the owned microphone track; it always invokes `cleanupShare()` first so no connection-bound lease survives a rebuild.

Full-call cleanup order:

1. prevent new operations by advancing the call generation;
2. stop lease renewal and release when possible;
3. replace sender tracks with null;
4. stop owned local tracks;
5. detach remote elements/listeners;
6. close PeerConnection and WSS;
7. clear timers and bounded caches;
8. update UI state.

Local cleanup continues if the network ack is lost.

**Step 7: Implement the quality panel**

Show actual capture resolution/FPS, send bitrate/FPS, receive decode/presentation FPS, loss, RTT, codec, and direct/relay status. Keep it collapsed by default and label targets separately from actual values.

**Step 8: Verify and commit**

Run:

```powershell
pnpm --filter @wo/desktop test
pnpm --filter @wo/server test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: PASS with no unhandled rejection or pending fake timer.

```powershell
git add apps/desktop apps/server
git commit -m "feat: add call recovery and diagnostics"
```

### Task 15: Build the Four-Service Docker Compose Deployment

**Files:**
- Create: `apps/server/Dockerfile`
- Create: `.dockerignore`
- Create: `deploy/compose.yaml`
- Create: `deploy/compose.integration.yaml`
- Modify: `deploy/.env.example`
- Create: `deploy/caddy/Caddyfile`
- Create: `deploy/caddy/Caddyfile.integration`
- Create: `deploy/coturn/turnserver.conf`
- Create: `deploy/coturn/turnserver.integration.conf`
- Create: `deploy/scripts/preflight.mjs`
- Create: `deploy/scripts/smoke.mjs`
- Create: `docs/deployment.md`
- Create: `tests/contract/compose.contract.test.ts`
- Create: `tests/integration/compose-stack.integration.test.ts`
- Modify: `package.json`

**Step 1: Write failing Compose contract tests**

Invoke `docker compose config --format json` from the test and assert:

- exactly four long-running services: `caddy`, `server`, `postgres`, `coturn`;
- no Redis, RustFS, mediasoup, MinIO, recorder, or public STUN dependency;
- PostgreSQL and the server container have no host-published ports;
- only Caddy publishes 80/443 TCP;
- coturn publishes 3478 TCP/UDP and the configured UDP relay range;
- coturn is not attached to the application/PostgreSQL network and its config denies loopback, private, link-local, carrier-grade NAT, multicast, documentation, cloud-metadata, and IPv6 local peer destinations;
- secrets come from environment and are not hard-coded;
- all services have healthchecks and restart policies;
- server waits for healthy PostgreSQL and runs migrations before listening;
- images use reviewed, pinned patch tags or immutable digests.

**Step 2: Run the contract test to verify failure**

Run:

```powershell
pnpm exec vitest run --config vitest.root.config.ts tests/contract/compose.contract.test.ts
```

Expected: FAIL because deployment files do not exist.

**Step 3: Build a production server image**

Use repository root as the build context (`build.context: ..` from `deploy/compose.yaml`) and `apps/server/Dockerfile` as the Dockerfile. Use a multi-stage Dockerfile that installs the locked pnpm version with Corepack, performs `pnpm install --frozen-lockfile`, builds only required workspace packages, installs Argon2 native requirements, and copies only production output plus SQL migrations into the final non-root image. The root `.dockerignore` must therefore exclude every unrelated artifact; a child `apps/server/.dockerignore` would not protect this build context.

The final image must not contain media-lab source, test credentials, `.env`, Git data, pnpm store, Electron, or mediasoup binaries.

**Step 4: Create Compose with self-hosted networking**

Use an internal application network for Caddy/server/PostgreSQL and publish coturn directly through explicit mappings. Keep only static, non-secret flags in `deploy/coturn/turnserver.conf`:

```text
use-auth-secret
fingerprint
no-loopback-peers
no-multicast-peers
no-cli
```

Add repeated `denied-peer-ip` ranges covering IPv4/IPv6 loopback, RFC1918, link-local (including `169.254.169.254` metadata), CGNAT, benchmark, documentation, multicast, reserved, and unique-local destinations. Contract tests exercise representative addresses from every denied range and one allowed public test peer. Attach coturn only to a dedicated non-application network; it shares no Docker network with Caddy, server, or PostgreSQL.

coturn does not expand shell variables inside a mounted config file. Pass `--static-auth-secret`, `--realm`, `--min-port`, `--max-port`, and `--external-ip` as Compose `command` arguments expanded with required-value syntax such as `${TURN_SHARED_SECRET:?required}` from `deploy/.env`; verify the rendered command contains no literal `${` with `docker compose config`. Do not bake secrets into the image or generated files. Do not proxy TURN through Caddy. WebRTC remains DTLS-SRTP encrypted when relayed.

**Step 5: Add deployment preflight**

`preflight.mjs` validates Linux production host intent, Docker and Compose availability (Compose 2.24.4 or newer for `!override`), edited secrets, domain, public IPv4, TURN relay range, port conflicts, writable volume paths, and enough free disk. It prints exact firewall ports and exits nonzero on an unsafe production configuration.

**Step 6: Add health and smoke checks**

The smoke script waits for HTTPS readiness, registers three random test-email accounts, exchanges a signaling ticket for each, creates/joins a room, verifies third-user rejection, relays a synthetic offer/answer/candidate envelope, acquires/releases the screen lease, ends the room, logs out all sessions, and revokes the refresh families. It never prints tokens or SDP. Integration Compose uses a disposable PostgreSQL volume that teardown removes; do not invent account-delete or administrator-disable APIs for smoke cleanup.

**Step 7: Start the complete stack**

Local integration and public production are separate profiles. `deploy/compose.integration.yaml` uses Compose `ports: !override` for both Caddy and coturn so none of the base file's wildcard bindings survive, overrides the entire coturn command with local advertised host/IP/realm values, mounts a clearly named `turnserver.integration.conf` that permits only the loopback/test peer paths needed by same-host E2E, enables Caddy `tls internal`, bind-mounts `deploy/.certs/caddy-authority` at Caddy's local-authority directory so the generated `root.crt` is available to host test clients, and uses a disposable database volume. A contract test parses the merged JSON and requires every published Caddy/TURN/relay port `host_ip` to be `127.0.0.1` or `::1`. Tests separately assert the production Compose never mounts the relaxed integration coturn config. The integration override must not be used as production or ACL evidence.

Prepare a local integration env from the example, then run:

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.integration.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.integration.yaml up -d --build --wait
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.integration.yaml ps
node deploy/scripts/smoke.mjs --env-file=deploy/.env --ca-file=deploy/.certs/caddy-authority/root.crt
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.integration.yaml down -v
```

Expected: four services are healthy and the signaling smoke flow passes.

**Step 8: Verify real TURN allocation**

An allocation alone is insufficient. On the real public deployment, generate a short-lived credential through the authenticated server endpoint, then run coturn's `turnutils_peer` and `turnutils_uclient` from a second external host to exchange actual relay data through the published address over UDP and TCP. Reject a bad credential and verify representative loopback/private/link-local peer targets are denied. Do not accept a same-host hairpin-NAT result as public evidence. Record only candidate type, protocol, bidirectional relay success, ACL denial class, and expiry; redact addresses and credentials.

**Step 9: Run the deployment suite**

Run:

```powershell
pnpm exec vitest run --config vitest.root.config.ts tests/contract/compose.contract.test.ts
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/compose-stack.integration.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```

Expected: PASS.

**Step 10: Request code review and commit**

Use @superpowers:requesting-code-review, fix all P0-P2 findings, repeat Steps 7-9, then:

```powershell
git add apps/server/Dockerfile .dockerignore deploy docs/deployment.md tests/contract tests/integration package.json
git commit -m "feat: add one-command docker deployment"
```

### Task 16: Add Two-Client E2E, Security Gates, and Desktop Packaging

**Files:**
- Create: `apps/desktop/playwright.config.ts`
- Create: `apps/desktop/e2e/fixtures.ts`
- Create: `apps/desktop/e2e/auth-room.spec.ts`
- Create: `apps/desktop/e2e/voice-screen.spec.ts`
- Create: `apps/desktop/e2e/turn-relay.spec.ts`
- Create: `apps/desktop/electron.vite.acceptance.config.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/entitlements.mac.plist`
- Create: `apps/desktop/build/entitlements.mac.inherit.plist`
- Create: `apps/desktop/scripts/build-platform.mjs`
- Create: `tests/integration/auth-room-signaling.integration.test.ts`
- Create: `tests/integration/turn-relay.integration.test.ts`
- Create: `tests/security/redaction.test.ts`
- Create: `docs/release-checklist.md`
- Create: `docs/support-matrix.md`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Install Playwright and packaging dependencies**

Run:

```powershell
pnpm add -D --filter @wo/desktop @playwright/test playwright electron-builder
```

Add `test:e2e`, `package:win`, and `package:mac` scripts. Do not put signing credentials in package scripts or repository files.

**Step 2: Write failing server-stack integration tests**

Against the real Compose stack, cover registration/login/token rotation, two-person room binding, third-user rejection, one-use WSS tickets, authorized SDP/ICE relay, screen competition/expiry, server restart invalidating temporary rooms, and a forced TURN allocation.

Run:

```powershell
pnpm exec vitest run --config vitest.root.integration.config.ts tests/integration/auth-room-signaling.integration.test.ts tests/integration/turn-relay.integration.test.ts
```

Expected: FAIL until fixtures and complete stack hooks exist.

**Step 3: Write failing two-Electron E2E tests**

Each test launches two isolated Electron processes with separate user-data directories and deterministic fake microphone/screen sources. Cover:

- register/login, creator room code, joiner entry, and waiting-to-connected UI;
- bidirectional audio counters increasing;
- either side starts/stops sharing and ownership exchanges;
- Auto/2/4/6/8 Mbps selection without offer count or audio counter reset;
- direct candidate path;
- `iceTransportPolicy: 'relay'` test-only runtime mode using the self-hosted TURN server;
- WSS drop/resume, ICE restart, peer exit, track end, and app crash cleanup.

Use a distinct acceptance build entry, compile-time constant, app ID, and user-data directory for fake media and test-only diagnostics. The production build must tree-shake those imports completely; a runtime flag is not a security boundary.

**Step 4: Write failing security/redaction tests**

Search Caddy/app access logs (including failed WSS handshakes), structured logs, diagnostics, renderer storage, crash extras, and packaged resources. Assert they contain no password, access/refresh token, signaling ticket or raw subprotocol header, full email, room code, SDP, ICE address, TURN credential, source name, or window title. Verify the renderer bundle cannot import Node built-ins and the production package contains no certificate bypass.

**Step 5: Implement deterministic E2E fixtures**

Use Playwright's Electron support, the existing dynamic motion-source asset, a deterministic non-silent audio source, and two fixed app profiles. Track audio/video counters through a test-only sanitized diagnostics IPC channel that is compiled only into the separately identified acceptance build. The fixture reads `deploy/.certs/caddy-authority/root.crt`; the acceptance build may trust only the exact integration hostname plus that CA's SPKI fingerprint, and all other certificate errors fail. This verifier and fingerprint input are compile-time excluded from the production main process. Add an artifact scan that unpacks the production package and proves the fake-media entry, acceptance app ID, diagnostics IPC channel, and integration certificate verifier are absent. Fixture `finally` blocks terminate both Electron processes/motion sources and run the integration Compose `down -v` command even after a failed assertion.

**Step 6: Configure packaging**

Build Windows x64 and macOS arm64/x64 targets from their native runners. Include hardened runtime, `entitlements.mac.plist`, `entitlements.mac.inherit.plist`, and `extendInfo` entries for `NSMicrophoneUsageDescription` and `NSScreenCaptureUsageDescription`. Keep Windows code-signing and macOS signing/notarization environment-driven. Unsigned local artifacts are development evidence only, not release artifacts.

**Step 7: Run automated E2E and packaging verification**

Run on Windows:

```powershell
pnpm --filter @wo/desktop test:e2e
pnpm --filter @wo/desktop package:win
```

Run on macOS:

```bash
pnpm --filter @wo/desktop test:e2e
pnpm --filter @wo/desktop package:mac
```

Expected: E2E passes on each native runner; package smoke launch passes; signature/notarization status is recorded accurately.

**Step 8: Run the full repository verification**

Run:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Expected: all commands pass with no leaked test process or container.

**Step 9: Request code review and commit**

Use @superpowers:requesting-code-review, fix all P0-P2 findings, repeat Steps 7-8, then:

```powershell
git add apps/desktop tests/integration tests/security docs/release-checklist.md docs/support-matrix.md package.json pnpm-lock.yaml
git commit -m "test: add two-client rtc release gates"
```

### Task 17: Run Two-Device 1080p60 and Cross-Platform Certification

**Files:**
- Create: `scripts/acceptance/controller.mjs`
- Create: `scripts/acceptance/agent.mjs`
- Create: `scripts/acceptance/protocol.mjs`
- Create: `scripts/acceptance/firewall-policy.mjs`
- Create: `scripts/acceptance/firewall/windows.ps1`
- Create: `scripts/acceptance/firewall/macos.sh`
- Create: `scripts/acceptance/p2p-gate-policy.mjs`
- Create: `tests/acceptance/p2p-gate-policy.test.mjs`
- Create: `tests/acceptance/protocol.test.mjs`
- Create: `tests/acceptance/firewall-policy.test.mjs`
- Modify: `docs/poc/1080p60-matrix.md`
- Modify: `docs/support-matrix.md`
- Modify: `docs/release-checklist.md`

**Step 1: Write failing P2P gate-policy tests**

Reuse the proven rolling frame-counter and presentation-FPS algorithms, then replace mediasoup identity assumptions with P2P invariants. Test:

- 1920x1080 capture, encode, decode, and presentation coverage;
- at least 95% of valid rolling windows at or above 55 fps for sender encode and receiver presentation;
- stats/counter/presentation sample coverage of at least 95%, valid rolling-window coverage of at least 95%, maximum sample gap of 2 seconds, and measured quality duration of at least 600 seconds;
- no counter reset, long sample gap, black frame, or freeze breach;
- Auto/2/4/6/8 Mbps sender parameters applied without changing PeerConnection ID, transceiver count, screen MID, or negotiation count;
- 8 Mbps dynamic-content actual bitrate reaches the documented tolerance when the network is not limiting;
- a deterministic non-silent audio source whose remote inbound `packetsReceived`, `totalSamplesReceived`, and `totalAudioEnergy` counters continue progressing, with no progress gap above 2 seconds during screen start/stop or any bitrate change;
- direct and relay candidate-path requirements;
- for forced relay, every selected candidate-pair sample in the valid quality interval has local candidate type `relay`, with zero non-relay samples;
- for direct, every selected candidate-pair sample has no relay candidate on either side, with zero relay samples;
- redaction of IPs, credentials, emails, room codes, and source titles.

**Step 2: Run policy tests to verify failure**

Run:

```powershell
pnpm exec vitest run --config vitest.root.config.ts tests/acceptance/p2p-gate-policy.test.mjs
```

Expected: FAIL because the P2P acceptance policy does not exist.

**Step 3: Define and test the controller/agent protocol**

In `protocol.mjs`, define strict schemas for agent registration, capability report, prepare, start, sample, stop, artifact manifest, failure, and heartbeat. The protocol includes run ID, monotonic sequence, wall-clock/monotonic clock pair, allowed skew, per-step timeout, cancellation, and cleanup acknowledgement. Agents use a per-run short-lived token or mTLS; secrets are supplied through a restricted file/environment variable and never CLI output.

Write tests for bad token, replayed sequence, excessive clock skew, lost heartbeat, timeout, cancellation, and cleanup after either agent fails.

Define external firewall adapters for the formal production-package relay runs. They block peer-to-peer UDP/TCP while allowing DNS, HTTPS/WSS, and only the declared TURN host/port, without changing the packaged app. Rules use a unique run ID, require elevated privileges, record the exact installed rules, include a watchdog restore, remove rules in `finally`, and verify the original policy was restored. A run aborts before media starts if installation or restoration cannot be proven.

**Step 4: Implement the controller/agent harness**

The controller coordinates two physical devices over those authenticated test control channels. Each agent verifies the immutable signed installer/archive SHA-256 and signature/notarization status, installs or extracts it, then launches the exact packaged production client artifact, an external deterministic motion-source window, and a documented deterministic non-silent virtual microphone/input. Test automation drives and reads the normal UI/quality panel from outside the package; it does not use the Task 16 acceptance-only IPC. Each agent records sanitized local stats and returns an artifact manifest with SHA-256 hashes for the installer/archive, executable, `app.asar`, and relevant resources. The controller never transports raw media or credentials.

Start each agent with explicit endpoints and restricted credential files:

```powershell
node scripts/acceptance/agent.mjs --listen=https://0.0.0.0:9443 --cert-file=C:\acceptance\agent-cert.pem --key-file=C:\acceptance\agent-key.pem --token-file=C:\acceptance\run-token.txt --desktop-package=C:\acceptance\Wo-signed-setup.exe --desktop-package-sha256-file=C:\acceptance\Wo-signed-setup.exe.sha256 --work-dir=C:\acceptance\runs
```

The controller requires `--ca-file` and `--token-file` in addition to the agent/server/run arguments shown below. The agent verifies the token before accepting any command, bounds concurrent runs to one, terminates the child app/motion source on timeout or cancellation, restores acceptance firewall rules, and acknowledges cleanup before reporting completion. For `--path=relay`, both agents must successfully install the external firewall policy before launch and the gate independently requires the selected pair to remain relay for the full valid interval; the CLI flag alone is never treated as proof.

Record OS version, hardware, Electron/Chromium version, codec/fmtp, encoder/decoder implementation, power-efficiency evidence where available, capture source type, direct/relay path, resolution, rolling FPS, presentation FPS, bitrate, audio continuity, loss, RTT, negotiation count, stable transceiver/MID identity, and all gate failures.

**Step 5: Run short two-device preflights**

Run a 45-second preflight for every row in the complete platform-direction x path x source Cartesian product that will later be claimed:

| Publisher -> receiver | Path | Sources |
|---|---|---|
| Windows -> Windows | direct and forced relay | window and monitor |
| Windows -> macOS | direct and forced relay | window and monitor |
| macOS -> Windows | direct and forced relay | window and monitor |
| macOS -> macOS | direct and forced relay | window and monitor |

Both peers must exchange screen ownership and produce separately evaluated publisher/receiver metrics in each platform pair. A platform/path/source combination that has no passing preflight may not enter a formal run or be declared supported.

Expected: every short run passes before formal duration is attempted. A failure is investigated with @superpowers:systematic-debugging; do not average a failing direction into a pass.

**Step 6: Run formal 600-second gates**

For each claimed platform/direction/path, run:

```powershell
node scripts/acceptance/controller.mjs --duration=600 --publisher-agent=https://win-a.example:9443 --receiver-agent=https://mac-a.example:9443 --server-url=https://rtc.example.com --path=direct --source=window --ca-file=C:\acceptance\ca.pem --token-file=C:\acceptance\run-token.txt --run-dir=docs/poc/results/p2p-run-id
node scripts/acceptance/controller.mjs --duration=600 --publisher-agent=https://win-a.example:9443 --receiver-agent=https://mac-a.example:9443 --server-url=https://rtc.example.com --path=relay --source=monitor --ca-file=C:\acceptance\ca.pem --token-file=C:\acceptance\run-token.txt --run-dir=docs/poc/results/p2p-run-id
```

Expected: `HARDWARE_PASS` only when every required resolution, sender, receiver-presentation, coverage, sample-gap, audio, bitrate, stability, path, duration, artifact-hash, and redaction gate passes.

**Step 7: Update the support matrix honestly**

Record each tested hardware/OS pair as pass or fail with evidence directory and limitations. Keep unrun macOS, Intel/AMD, monitor/window, direct/relay, or direction combinations as `NOT TESTED`; do not infer them from Windows NVIDIA evidence.

**Step 8: Run final verification**

Use @superpowers:verification-before-completion, then run:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
git status --short
```

Expected: all automated checks pass, required formal evidence is `HARDWARE_PASS`, and only intentionally ignored local evidence directories remain untracked.

**Step 9: Commit certification tooling and reviewed matrices**

```powershell
git add scripts/acceptance tests/acceptance docs/poc/1080p60-matrix.md docs/support-matrix.md docs/release-checklist.md
git commit -m "test: certify two-device 1080p60 p2p sharing"
```

If any required formal gate fails, commit the tooling and failure matrix with a non-certifying message instead, leave Task 17 incomplete, and report the exact failed metric.

## Milestones

- **After Task 10:** two authenticated users can create/join a temporary room and exchange authorized P2P signaling plus self-hosted TURN credentials.
- **After Task 12:** two desktop clients can complete a bidirectional voice call.
- **After Task 13:** either peer can use one desktop share and adjust runtime bitrate without renegotiating or interrupting voice.
- **After Task 15:** the server stack starts with one documented Docker Compose command and uses no external realtime service.
- **After Task 16:** automated two-client, forced-relay, security, and native packaging gates exist.
- **After Task 17:** supported Windows/macOS hardware rows have honest two-device 1080p60 evidence.

## MVP Completion Command Set

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm --filter @wo/desktop test:e2e
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
node deploy/scripts/smoke.mjs --env-file=deploy/.env
```

The MVP is not complete merely because these commands pass: the Windows/macOS support claims must also match the Task 17 physical-device matrix.
