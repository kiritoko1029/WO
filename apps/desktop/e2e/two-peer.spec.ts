import type { Page } from '@playwright/test';

import {
  expect,
  test,
  type AcceptancePair,
  type AcceptancePolicy,
} from './fixtures.js';

interface PeerDiagnostic {
  readonly id: number;
  readonly offers: number;
  readonly answers: number;
  readonly closed: boolean;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly signalingState: string;
  readonly transceivers: number;
  readonly liveRemoteAudioTracks: number;
  readonly liveRemoteVideoTracks: number;
  readonly packetsSentAudio: number;
  readonly packetsReceivedAudio: number;
  readonly bytesSentAudio: number;
  readonly bytesReceivedAudio: number;
  readonly inboundAudioEnergy: number;
  readonly localAudioEnergy: number;
  readonly maximumAudioLevel: number;
  readonly framesSentVideo: number;
  readonly framesReceivedVideo: number;
  readonly bytesSentVideo: number;
  readonly bytesReceivedVideo: number;
  readonly localIceType: string;
  readonly remoteIceType: string;
  readonly screenMaxBitrate: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly screenFrameRate: number;
}

interface AcceptanceSnapshot {
  readonly sequence: number;
  readonly icePolicy: AcceptancePolicy;
  readonly signalingDrops: number;
  readonly capture: Readonly<{
    attempts: number;
    successes: number;
    lastName: string;
    tracks: number;
    videoTracks: number;
    audioTracks: number;
    width: number;
    height: number;
    frameRate: number;
  }>;
  readonly peers: readonly PeerDiagnostic[];
  readonly sockets: readonly Readonly<{
    id: number;
    state: number;
    opens: number;
    closes: number;
  }>[];
}

const password = 'Wo-E2E-Password-2026';

async function diagnostics(page: Page): Promise<AcceptanceSnapshot | null> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptance: { snapshot(): Promise<AcceptanceSnapshot | null> };
      }
    ).woAcceptance.snapshot(),
  );
}

function activePeer(
  snapshot: AcceptanceSnapshot | null,
): PeerDiagnostic | null {
  return snapshot?.peers.findLast((peer) => !peer.closed) ?? null;
}

async function waitForPeer(
  page: Page,
  predicate: (peer: PeerDiagnostic, snapshot: AcceptanceSnapshot) => boolean,
  timeout = 45_000,
): Promise<PeerDiagnostic> {
  await expect
    .poll(
      async () => {
        const snapshot = await diagnostics(page);
        const peer = activePeer(snapshot);
        return snapshot !== null && peer !== null && predicate(peer, snapshot);
      },
      { timeout },
    )
    .toBe(true);
  const snapshot = await diagnostics(page);
  const peer = activePeer(snapshot);
  if (peer === null) throw new Error('Active peer diagnostics disappeared');
  return peer;
}

async function registerThenLogin(
  page: Page,
  displayName: string,
  email: string,
): Promise<void> {
  await page.getByRole('tab', { name: '注册账号' }).click();
  await page.getByLabel('显示名称').fill(displayName);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '登录 WO' })).toBeVisible();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
}

async function connectRoom(pair: AcceptancePair): Promise<void> {
  await pair.first.page.getByRole('button', { name: '创建房间' }).click();
  const code = pair.first.page.locator('.room-header code');
  await expect(code).toHaveText(/^\d{6}$/u);
  await pair.second.page.getByLabel('房间码').fill(await code.innerText());
  await pair.second.page.getByRole('button', { name: '加入房间' }).click();

  const connected = /语音已连接/u;
  await expect(pair.first.page.getByText(connected)).toBeVisible({
    timeout: 45_000,
  });
  await expect(pair.second.page.getByText(connected)).toBeVisible({
    timeout: 45_000,
  });
}

async function proveBidirectionalAudio(pair: AcceptancePair): Promise<void> {
  const firstStart = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.connectionState === 'connected' &&
      peer.liveRemoteAudioTracks === 1 &&
      peer.packetsReceivedAudio > 5 &&
      peer.packetsSentAudio > 5 &&
      peer.inboundAudioEnergy > 0,
  );
  const secondStart = await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.connectionState === 'connected' &&
      peer.liveRemoteAudioTracks === 1 &&
      peer.packetsReceivedAudio > 5 &&
      peer.packetsSentAudio > 5 &&
      peer.inboundAudioEnergy > 0,
  );

  await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstStart.id &&
      peer.packetsReceivedAudio > firstStart.packetsReceivedAudio &&
      peer.packetsSentAudio > firstStart.packetsSentAudio &&
      peer.bytesReceivedAudio > firstStart.bytesReceivedAudio,
  );
  await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondStart.id &&
      peer.packetsReceivedAudio > secondStart.packetsReceivedAudio &&
      peer.packetsSentAudio > secondStart.packetsSentAudio &&
      peer.bytesReceivedAudio > secondStart.bytesReceivedAudio,
  );
}

async function startMotionShare(
  page: Page,
  motionTitle: string,
): Promise<void> {
  await page.getByRole('button', { name: '共享屏幕' }).click();
  const dialog = page.getByRole('dialog', { name: '选择共享内容' });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: `${motionTitle}，窗口`, exact: true })
    .click();
  await dialog.getByRole('button', { name: '开始共享' }).click();
  const toolbar = page.getByLabel('屏幕共享状态');
  const alert = page.locator('.room-error');
  await expect
    .poll(
      async () => {
        if ((await toolbar.count()) > 0) return 'sharing';
        return (await alert.innerText()).trim() === '' ? 'pending' : 'failed';
      },
      { timeout: 30_000 },
    )
    .not.toBe('pending');
  if ((await toolbar.count()) === 0) {
    throw new Error(
      `Screen capture failed: ${(await alert.innerText()).trim()} ${JSON.stringify((await diagnostics(page))?.capture ?? null)}`,
    );
  }
}

async function proveScreenAndBitrates(pair: AcceptancePair): Promise<void> {
  await startMotionShare(pair.first.page, pair.motionTitle);
  const remoteVideo = pair.second.page.locator(
    'video[aria-label$="的共享屏幕"]',
  );
  await expect(remoteVideo).toBeVisible({ timeout: 45_000 });
  const initial = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.screenWidth === 1920 &&
      peer.screenHeight === 1080 &&
      peer.screenFrameRate >= 55 &&
      peer.framesSentVideo > 5,
  );
  await waitForPeer(
    pair.second.page,
    (peer) => peer.framesReceivedVideo > 5 && peer.liveRemoteVideoTracks === 1,
  );
  const negotiationCount = initial.offers + initial.answers;

  for (const [label, bitrate] of [
    ['2 Mbps', 2_000_000],
    ['4 Mbps', 4_000_000],
    ['6 Mbps', 6_000_000],
    ['8 Mbps', 8_000_000],
    ['自动', 0],
  ] as const) {
    const remoteBefore = await waitForPeer(pair.second.page, () => true);
    await pair.first.page.getByRole('button', { name: label }).click();
    await expect(
      pair.first.page.getByRole('button', { name: label }),
    ).toHaveAttribute('aria-pressed', 'true');
    await waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === initial.id &&
        peer.offers + peer.answers === negotiationCount &&
        peer.screenMaxBitrate === bitrate &&
        peer.packetsSentAudio > initial.packetsSentAudio,
    );
    await waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === remoteBefore.id &&
        peer.packetsReceivedAudio > remoteBefore.packetsReceivedAudio &&
        peer.framesReceivedVideo > remoteBefore.framesReceivedVideo,
    );
  }

  const stopped = await pair.first.page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { stopLocalScreenTrack(): number };
      }
    ).woAcceptanceControl.stopLocalScreenTrack(),
  );
  expect(stopped).toBe(1);
  await expect(pair.first.page.getByLabel('屏幕共享状态')).toHaveCount(0);
  await expect(remoteVideo).toHaveCount(0, { timeout: 30_000 });

  await startMotionShare(pair.second.page, pair.motionTitle);
  await expect(
    pair.first.page.locator('video[aria-label$="的共享屏幕"]'),
  ).toBeVisible({ timeout: 45_000 });
  await waitForPeer(
    pair.first.page,
    (peer) => peer.framesReceivedVideo > 5 && peer.liveRemoteVideoTracks === 1,
  );
  await pair.second.page.getByRole('button', { name: '停止共享' }).click();
  await expect(
    pair.first.page.locator('video[aria-label$="的共享屏幕"]'),
  ).toHaveCount(0, { timeout: 30_000 });
}

async function proveSignalingRecovery(pair: AcceptancePair): Promise<void> {
  const before = await waitForPeer(pair.first.page, () => true);
  const closed = await pair.first.page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { dropSignaling(): number };
      }
    ).woAcceptanceControl.dropSignaling(),
  );
  expect(closed).toBe(1);
  await expect(pair.first.page.getByText(/语音已连接/u)).toBeVisible({
    timeout: 45_000,
  });
  await waitForPeer(
    pair.first.page,
    (peer, snapshot) =>
      snapshot.signalingDrops === 1 &&
      snapshot.sockets.length >= 2 &&
      snapshot.sockets.some(
        (socket) => socket.opens > 0 && socket.closes > 0,
      ) &&
      snapshot.sockets.some(
        (socket) => socket.opens > 0 && socket.closes === 0,
      ) &&
      peer.id === before.id &&
      peer.connectionState === 'connected' &&
      peer.packetsReceivedAudio > before.packetsReceivedAudio,
    60_000,
  );
}

for (const policy of ['all', 'relay'] as const) {
  test(`real two-peer ${policy === 'all' ? 'direct' : 'forced relay'} path`, async ({
    acceptance,
  }) => {
    const pair = await acceptance.launch(policy);
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await Promise.all([
      registerThenLogin(
        pair.first.page,
        `Alice-${policy}`,
        `alice-${policy}-${run}@e2e.invalid`,
      ),
      registerThenLogin(
        pair.second.page,
        `Bob-${policy}`,
        `bob-${policy}-${run}@e2e.invalid`,
      ),
    ]);
    await connectRoom(pair);
    await proveBidirectionalAudio(pair);

    const first = await waitForPeer(pair.first.page, () => true);
    const second = await waitForPeer(pair.second.page, () => true);
    expect(first.transceivers).toBe(2);
    expect(second.transceivers).toBe(2);
    if (policy === 'relay') {
      expect(first.localIceType).toBe('relay');
      expect(first.remoteIceType).toBe('relay');
      expect(second.localIceType).toBe('relay');
      expect(second.remoteIceType).toBe('relay');
      await expect(
        pair.first.page.getByText('语音已连接（中继）'),
      ).toBeVisible();
    } else {
      expect(first.localIceType).not.toBe('');
      expect(first.remoteIceType).not.toBe('');
      expect(second.localIceType).not.toBe('');
      expect(second.remoteIceType).not.toBe('');
      expect(first.localIceType).not.toBe('relay');
      expect(first.remoteIceType).not.toBe('relay');
      expect(second.localIceType).not.toBe('relay');
      expect(second.remoteIceType).not.toBe('relay');
    }

    await proveScreenAndBitrates(pair);
    await proveSignalingRecovery(pair);

    await pair.second.close();
    await expect(pair.first.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    });
    await expect(pair.first.page.locator('[title="离线"]')).toBeVisible();
  });
}
