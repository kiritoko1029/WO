# LAN Screen Share Receive And Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a LAN room joiner display the host's shared screen and show the sharing peer a local non-mirrored preview.

**Architecture:** Keep the fixed audio/screen transceiver plan. Reconcile the negotiated screen receiver whenever remote ownership becomes authoritative, and project the existing screen sender track into call state for local preview. Render either the authorized remote track or the active local track in the existing screen stage without changing signaling or the screen capture state machine.

**Tech Stack:** TypeScript, React, WebRTC, Vitest, Testing Library, GitNexus.

---

### Task 1: Reconcile Remote And Local Screen Tracks

**Files:**
- Modify: `apps/desktop/test/call-store.test.ts`
- Modify: `apps/desktop/src/renderer/src/state/call-store.tsx`

**Step 1: Write the failing remote receiver regression**

Add a focused call-store test whose joiner finishes negotiation while
`screen.receiver.track` is temporarily unavailable. Set the receiver track
afterward, emit a remote `screen.ownerChanged`, and assert:

```ts
expect(call.getSnapshot()).toMatchObject({
  screenOwner: { userId: 'user-1', displayName: 'Host' },
  remoteScreenTrack: remoteTrack,
});
```

The test must use the existing signaling and peer-connection harness rather
than mocking `createCallController`.

**Step 2: Run the test to verify RED**

Run:

```bash
pnpm --filter @wo/desktop test -- --run test/call-store.test.ts -t "resynchronizes the negotiated screen receiver when remote ownership starts"
```

Expected: FAIL because `screen.ownerChanged` updates ownership but leaves
`remoteScreenTrack` as `null`.

**Step 3: Implement the minimal remote reconciliation**

In the `screen.ownerChanged` branch, after applying the authoritative owner,
call the existing `syncNegotiatedScreenReceiver()` only when the owner is
remote. Preserve the existing negotiation-ready sync and remote track ended
cleanup.

**Step 4: Run the remote regression to verify GREEN**

Run the Step 2 command again.

Expected: PASS.

**Step 5: Write the failing local sender projection regression**

Extend `CallSnapshot` expectations with `localScreenTrack`. Use the screen
capture harness to start sharing and make the fake sender's `replaceTrack`
update its `track` property. Assert:

```ts
expect(call.getSnapshot()).toMatchObject({
  screenState: 'sharing',
  localScreenTrack: capturedTrack,
});

await call.stopScreenShare();

expect(call.getSnapshot()).toMatchObject({
  screenState: 'idle',
  localScreenTrack: null,
});
```

**Step 6: Run the local projection test to verify RED**

Run:

```bash
pnpm --filter @wo/desktop test -- --run test/call-store.test.ts -t "projects and clears the active local screen sender track"
```

Expected: FAIL because `CallSnapshot` has no `localScreenTrack`.

**Step 7: Implement the minimal local projection**

Add:

```ts
readonly localScreenTrack: MediaStreamTrack | null;
```

Initialize it to `null`. In `syncScreenSnapshot`, derive it only when the screen
controller state is `sharing`:

```ts
localScreenTrack:
  screenSnapshot.state === 'sharing'
    ? (peer?.screenSender?.track ?? null)
    : null,
```

Explicitly clear the field in screen controller disposal, transport reset, and
fallback snapshots where those paths already clear screen state.

**Step 8: Run call-store tests**

Run:

```bash
pnpm --filter @wo/desktop test -- --run test/call-store.test.ts
```

Expected: PASS.

**Step 9: Commit the state-layer change**

```bash
git add apps/desktop/test/call-store.test.ts apps/desktop/src/renderer/src/state/call-store.tsx
git commit -m "fix(desktop): reconcile LAN screen tracks"
```

### Task 2: Render The Sharing Peer's Local Preview

**Files:**
- Modify: `apps/desktop/test/screen-components.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ScreenStage.tsx`
- Modify: `apps/desktop/src/renderer/src/routes/RoomRoute.tsx`

**Step 1: Write the failing component regression**

Add `localTrack` to every `ScreenStage` test render. Add a test with
`localState="sharing"`, a live local video track, and no remote owner. Assert:

```ts
const preview = screen.getByLabelText('本地共享预览');
expect(preview.tagName).toBe('VIDEO');
expect((preview as HTMLVideoElement).muted).toBe(true);
expect(screen.queryByText('您正在共享屏幕')).toBeNull();
```

Retain the existing tests proving a pre-negotiated remote receiver remains
hidden until a remote owner exists.

**Step 2: Run the component test to verify RED**

Run:

```bash
pnpm --filter @wo/desktop test -- --run test/screen-components.test.tsx -t "previews the local screen track while sharing"
```

Expected: FAIL because `ScreenStage` does not accept or render `localTrack`.

**Step 3: Implement the shared stage rendering**

In `ScreenStage`:

- add `localTrack: MediaStreamTrack | null`;
- select remote presentation first when remote owner and track are present;
- otherwise select the local track when `localState === 'sharing'`;
- attach the selected track through the existing `MediaStream` effect;
- label local video `本地共享预览`, keep it non-mirrored, and set `muted`;
- keep `onPresentationVideo` connected only for a remote presentation so
  inbound presentation FPS metrics are not polluted by local preview frames.

In `RoomRoute`, pass:

```tsx
localTrack={call.snapshot.localScreenTrack}
```

**Step 4: Run component tests**

Run:

```bash
pnpm --filter @wo/desktop test -- --run test/screen-components.test.tsx
```

Expected: PASS.

**Step 5: Run the desktop test suite**

Run:

```bash
pnpm --filter @wo/desktop test
```

Expected: PASS with no new warnings.

**Step 6: Commit the presentation change**

```bash
git add apps/desktop/test/screen-components.test.tsx apps/desktop/src/renderer/src/components/ScreenStage.tsx apps/desktop/src/renderer/src/routes/RoomRoute.tsx
git commit -m "feat(desktop): preview the shared screen locally"
```

### Task 3: Quality And Impact Verification

**Files:**
- Verify only; no planned production edits.

**Step 1: Run type checking**

```bash
pnpm --filter @wo/desktop typecheck
```

Expected: PASS.

**Step 2: Run lint**

```bash
pnpm lint
```

Expected: PASS.

**Step 3: Run the LAN service integration regression**

```bash
pnpm --filter @wo/server test:integration -- --run test/lite-room-service.integration.test.ts
```

Expected: PASS, proving the LAN signaling and authenticated room service remain
compatible.

**Step 4: Run GitNexus change detection**

```bash
node .gitnexus/run.cjs detect-changes --scope compare --base-ref main
```

Expected: only desktop call-state and screen presentation symbols and their
tests are reported. Any signaling service, room registry, or
`createScreenController` change requires design review before proceeding.

**Step 5: Inspect the final diff**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing workspace changes remain
untouched.
