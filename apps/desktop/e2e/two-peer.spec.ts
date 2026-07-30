import { writeFile } from 'node:fs/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import {
  expect,
  pauseIntegrationCoturn,
  restartIntegrationServer,
  test,
  type AcceptancePair,
  type AcceptancePolicy,
} from './fixtures.js';

interface PeerDiagnostic {
  readonly id: number;
  readonly offers: number;
  readonly answers: number;
  readonly restartIceCalls: number;
  readonly holdDisconnectedIceEvents: boolean;
  readonly heldDisconnectedIceEvents: number;
  readonly closed: boolean;
  readonly connectionState: string;
  readonly connectionStateHistory: readonly string[];
  readonly iceConnectionState: string;
  readonly iceConnectionStateHistory: readonly string[];
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
  readonly callStatus: string;
  readonly callStatusHistory: readonly string[];
  readonly signalingDrops: number;
  readonly signalingPaused: boolean;
  readonly blockedSignalingAttempts: number;
  readonly screenLeaseMaintenancePaused: boolean;
  readonly blockedScreenLeaseRenewals: number;
  readonly blockedScreenLeaseReleases: number;
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
  readonly rnnoise: Readonly<{
    processorCreations: number;
    processedFrames: number;
    audioProcessCallbacks: number;
    maxCallbackGapMs: number;
    lastCallbackAtMs: number;
  }>;
  readonly resources: Readonly<{
    activePeerConnections: number;
    openSignalingSockets: number;
    liveMicrophoneTracks: number;
    liveSystemAudioTracks: number;
    activeRnnoiseAudioContexts: number;
  }>;
  readonly rnnoiseActive: boolean;
  readonly peers: readonly PeerDiagnostic[];
  readonly sockets: readonly Readonly<{
    id: number;
    state: number;
    opens: number;
    closes: number;
    lastCloseCode: number | null;
    lastCloseReason: string | null;
  }>[];
}

const password = 'Wo-E2E-Password-2026';
const maxRnnoiseCallbackGapMs = 5_000;
const maxRnnoiseTotalCpuPercent = 50;
const maxRnnoiseProcessCpuPercent = 25;
const v13MinimumSoakDurationMs = 10 * 60_000;
const v13MaximumSoakDurationMs = 30 * 60_000;
const v13RecoveryIntervalMs = 60_000;
const v13MemoryGrowthBudgetKiB = 256 * 1_024;
const v13ProcessGrowthBudget = 2;

interface ProcessCpuSample {
  readonly pid: number;
  readonly type: string;
  readonly percentCPUUsage: number;
}

interface AppCpuSample {
  readonly sampledAt: number;
  readonly processes: readonly ProcessCpuSample[];
  readonly totalPercentCPUUsage: number;
  readonly maxPercentCPUUsage: number;
}

interface ProcessMemorySample {
  readonly pid: number;
  readonly type: string;
  readonly workingSetSizeKiB: number;
  readonly peakWorkingSetSizeKiB: number;
}

interface AppMemorySample {
  readonly sampledAt: number;
  readonly processes: readonly ProcessMemorySample[];
  readonly totalWorkingSetSizeKiB: number;
  readonly maxWorkingSetSizeKiB: number;
}

interface NoiseIntensitySwitchReport {
  readonly firstProcessorCreations: number;
  readonly secondProcessorCreations: number;
  readonly firstMaxCallbackGapMs: number;
  readonly secondMaxCallbackGapMs: number;
  readonly cpu: readonly Readonly<{
    intensity: 'light' | 'medium' | 'aggressive';
    first: AppCpuSample;
    second: AppCpuSample;
  }>[];
}

interface ExplicitDepartureReport {
  readonly creatorBeforeLeave: PeerDiagnostic;
  readonly joinerBeforeLeave: PeerDiagnostic;
  readonly creatorClosed: PeerDiagnostic;
  readonly joinerClosed: PeerDiagnostic;
  readonly creatorWaiting: PeerDiagnostic;
}

interface ExplicitRejoinStageReport extends ExplicitDepartureReport {
  readonly creatorRejoined: PeerDiagnostic;
  readonly joinerRejoined: PeerDiagnostic;
}

interface ExplicitLeaveRejoinReport {
  readonly roomCodeLength: number;
  readonly sameRoomCodeReused: true;
  readonly sameUser: ExplicitRejoinStageReport;
  readonly newUser: ExplicitRejoinStageReport;
}

interface SignalingRecoveryStageReport {
  readonly firstBefore: PeerDiagnostic;
  readonly secondBefore: PeerDiagnostic;
  readonly firstAfter: PeerDiagnostic;
  readonly secondAfter: PeerDiagnostic;
}

interface SignalingRecoveryReport {
  readonly short: SignalingRecoveryStageReport;
  readonly long: SignalingRecoveryStageReport &
    Readonly<{
      blockedAttempts: number;
      firstDuring: PeerDiagnostic;
      pauseDurationMs: number;
      secondDuring: PeerDiagnostic;
    }>;
}

interface IceRestartRecoveryReport {
  readonly firstBefore: PeerDiagnostic;
  readonly secondBefore: PeerDiagnostic;
  readonly firstDuring: PeerDiagnostic;
  readonly secondDuring: PeerDiagnostic;
  readonly firstAfter: PeerDiagnostic;
  readonly secondAfter: PeerDiagnostic;
  readonly firstStatusDuring: string;
  readonly secondStatusDuring: string;
  readonly firstStatusHistoryDuring: readonly string[];
  readonly secondStatusHistoryDuring: readonly string[];
}

interface IceResetRecoveryReport {
  readonly firstBefore: PeerDiagnostic;
  readonly secondBefore: PeerDiagnostic;
  readonly firstFailed: PeerDiagnostic;
  readonly secondFailed: PeerDiagnostic;
  readonly firstClosed: PeerDiagnostic;
  readonly secondClosed: PeerDiagnostic;
  readonly firstReset: PeerDiagnostic;
  readonly secondReset: PeerDiagnostic;
  readonly firstAfter: PeerDiagnostic;
  readonly secondAfter: PeerDiagnostic;
  readonly firstSnapshotAfter: AcceptanceSnapshot;
  readonly secondSnapshotAfter: AcceptanceSnapshot;
  readonly firstStatusHistoryDuring: readonly string[];
  readonly secondStatusHistoryDuring: readonly string[];
}

async function diagnostics(page: Page): Promise<AcceptanceSnapshot | null> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptance: { snapshot(): Promise<AcceptanceSnapshot | null> };
      }
    ).woAcceptance.snapshot(),
  );
}

async function requiredDiagnostics(page: Page): Promise<AcceptanceSnapshot> {
  const value = await diagnostics(page);
  if (value === null) throw new Error('Acceptance diagnostics are unavailable');
  return value;
}

async function connectionStatus(page: Page): Promise<string> {
  return page.locator('.room-identity > strong').innerText();
}

async function holdDisconnectedIceEvents(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: {
          holdDisconnectedIceEvents(): number;
        };
      }
    ).woAcceptanceControl.holdDisconnectedIceEvents(),
  );
}

async function resetRnnoiseCallbackGap(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { resetRnnoiseCallbackGap(): number };
      }
    ).woAcceptanceControl.resetRnnoiseCallbackGap(),
  );
}

async function cpuSample(
  application: ElectronApplication,
): Promise<AppCpuSample> {
  const processes = await application.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      percentCPUUsage: metric.cpu.percentCPUUsage,
    })),
  );
  expect(processes.length).toBeGreaterThan(0);
  for (const process of processes) {
    expect(Number.isFinite(process.percentCPUUsage)).toBe(true);
    expect(process.percentCPUUsage).toBeGreaterThanOrEqual(0);
    expect(process.percentCPUUsage).toBeLessThanOrEqual(100);
  }
  const sample = {
    sampledAt: Date.now(),
    processes,
    totalPercentCPUUsage: processes.reduce(
      (total, process) => total + process.percentCPUUsage,
      0,
    ),
    maxPercentCPUUsage: Math.max(
      ...processes.map((process) => process.percentCPUUsage),
    ),
  };
  expect(sample.totalPercentCPUUsage).toBeLessThanOrEqual(
    maxRnnoiseTotalCpuPercent,
  );
  expect(sample.maxPercentCPUUsage).toBeLessThanOrEqual(
    maxRnnoiseProcessCpuPercent,
  );
  return sample;
}

async function memorySample(
  application: ElectronApplication,
): Promise<AppMemorySample> {
  const processes = await application.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      workingSetSizeKiB: metric.memory.workingSetSize,
      peakWorkingSetSizeKiB: metric.memory.peakWorkingSetSize,
    })),
  );
  expect(processes.length).toBeGreaterThan(0);
  for (const process of processes) {
    expect(Number.isFinite(process.workingSetSizeKiB)).toBe(true);
    expect(process.workingSetSizeKiB).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(process.peakWorkingSetSizeKiB)).toBe(true);
    expect(process.peakWorkingSetSizeKiB).toBeGreaterThanOrEqual(
      process.workingSetSizeKiB,
    );
  }
  return {
    sampledAt: Date.now(),
    processes,
    totalWorkingSetSizeKiB: processes.reduce(
      (total, process) => total + process.workingSetSizeKiB,
      0,
    ),
    maxWorkingSetSizeKiB: Math.max(
      ...processes.map((process) => process.workingSetSizeKiB),
    ),
  };
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
  let latestSnapshot: AcceptanceSnapshot | null = null;
  try {
    await expect
      .poll(
        async () => {
          latestSnapshot = await diagnostics(page);
          const peer = activePeer(latestSnapshot);
          return (
            latestSnapshot !== null &&
            peer !== null &&
            predicate(peer, latestSnapshot)
          );
        },
        { timeout },
      )
      .toBe(true);
  } catch (error) {
    const details = JSON.stringify(latestSnapshot).slice(0, 8_192);
    throw new Error(`Peer diagnostic predicate timed out: ${details}`, {
      cause: error,
    });
  }
  const snapshot = await diagnostics(page);
  const peer = activePeer(snapshot);
  if (peer === null) throw new Error('Active peer diagnostics disappeared');
  return peer;
}

async function waitForPeerDiagnostic(
  page: Page,
  peerId: number,
  predicate: (peer: PeerDiagnostic, snapshot: AcceptanceSnapshot) => boolean,
  timeout = 60_000,
): Promise<PeerDiagnostic> {
  let latestSnapshot: AcceptanceSnapshot | null = null;
  try {
    await expect
      .poll(
        async () => {
          latestSnapshot = await diagnostics(page);
          const peer = latestSnapshot?.peers.find(
            (candidate) => candidate.id === peerId,
          );
          return (
            latestSnapshot !== null &&
            peer !== undefined &&
            predicate(peer, latestSnapshot)
          );
        },
        { timeout },
      )
      .toBe(true);
  } catch (error) {
    const details = JSON.stringify(latestSnapshot).slice(0, 8_192);
    throw new Error(
      `Peer ${peerId} diagnostic predicate timed out: ${details}`,
      { cause: error },
    );
  }
  const snapshot = await requiredDiagnostics(page);
  const peer = snapshot.peers.find((candidate) => candidate.id === peerId);
  if (peer === undefined) {
    throw new Error(`Peer ${peerId} disappeared from diagnostics`);
  }
  return peer;
}

async function waitForClosedPeer(
  page: Page,
  peerId: number,
  timeout = 45_000,
): Promise<PeerDiagnostic> {
  let latestSnapshot: AcceptanceSnapshot | null = null;
  try {
    await expect
      .poll(
        async () => {
          latestSnapshot = await diagnostics(page);
          return (
            latestSnapshot?.peers.find((peer) => peer.id === peerId)?.closed ??
            false
          );
        },
        { timeout },
      )
      .toBe(true);
  } catch (error) {
    const details = JSON.stringify(latestSnapshot).slice(0, 8_192);
    throw new Error(
      `Peer ${peerId} did not close after explicit leave: ${details}`,
      { cause: error },
    );
  }
  const snapshot = await requiredDiagnostics(page);
  const peer = snapshot.peers.find((candidate) => candidate.id === peerId);
  if (peer === undefined || !peer.closed) {
    throw new Error(`Closed peer ${peerId} disappeared from diagnostics`);
  }
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

async function registerPair(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
  run: string,
): Promise<void> {
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
}

async function loginExisting(page: Page, email: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
}

async function proveCameraRequestRejected(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });
      for (const track of stream.getTracks()) track.stop();
      return 'allowed';
    } catch (error) {
      return error instanceof DOMException ? error.name : 'Error';
    }
  });
  expect(result).toBe('NotAllowedError');
}

async function denyNextMicrophoneCapture(page: Page): Promise<void> {
  const pending = await page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { denyNextMicrophoneCapture(): number };
      }
    ).woAcceptanceControl.denyNextMicrophoneCapture(),
  );
  expect(pending).toBe(1);
}

async function proveScreenReceptionWithoutMicrophone(
  pair: AcceptancePair,
  firstBefore: PeerDiagnostic,
  secondBefore: PeerDiagnostic,
): Promise<void> {
  const firstNegotiations = firstBefore.offers + firstBefore.answers;
  const secondNegotiations = secondBefore.offers + secondBefore.answers;
  await startMotionShare(pair.second.page, pair.motionTitle);
  const remoteVideo = pair.first.page.locator(
    'video[aria-label$="的共享屏幕"]',
  );
  await expect(remoteVideo).toBeVisible({ timeout: 45_000 });
  await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstBefore.id &&
      peer.offers + peer.answers === firstNegotiations &&
      peer.framesReceivedVideo > firstBefore.framesReceivedVideo &&
      peer.liveRemoteVideoTracks === 1,
  );
  await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondBefore.id &&
      peer.offers + peer.answers === secondNegotiations &&
      peer.framesSentVideo > secondBefore.framesSentVideo,
  );
  await pair.second.page.getByRole('button', { name: '停止共享' }).click();
  await expect(remoteVideo).toHaveCount(0, { timeout: 30_000 });
}

async function connectRoom(
  pair: AcceptancePair,
  retryFirstMicrophone: boolean,
): Promise<void> {
  if (retryFirstMicrophone) {
    await denyNextMicrophoneCapture(pair.first.page);
  }
  await pair.first.page.getByRole('button', { name: '创建房间' }).click();
  const code = pair.first.page.locator('.room-header code');
  await expect(code).toHaveText(/^\d{6}$/u);
  await pair.second.page.getByLabel('房间码').fill(await code.innerText());
  await pair.second.page.getByRole('button', { name: '加入房间' }).click();

  if (retryFirstMicrophone) {
    const permissionError =
      pair.first.page.getByText('需要麦克风权限才能加入语音');
    const retry = pair.first.page.getByRole('button', {
      name: '重试麦克风',
    });
    await expect(permissionError).toBeVisible();
    await expect(retry).toBeVisible();
    const firstBefore = await waitForPeer(
      pair.first.page,
      (peer) => peer.connectionState === 'connected',
    );
    const secondBefore = await waitForPeer(
      pair.second.page,
      (peer) => peer.connectionState === 'connected',
    );
    const firstNegotiations = firstBefore.offers + firstBefore.answers;
    const secondNegotiations = secondBefore.offers + secondBefore.answers;

    await proveScreenReceptionWithoutMicrophone(
      pair,
      firstBefore,
      secondBefore,
    );
    await retry.click();

    await expect(permissionError).toHaveCount(0);
    await waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstBefore.id &&
        peer.offers + peer.answers === firstNegotiations &&
        peer.packetsSentAudio > firstBefore.packetsSentAudio,
    );
    await waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondBefore.id &&
        peer.offers + peer.answers === secondNegotiations &&
        peer.packetsReceivedAudio > secondBefore.packetsReceivedAudio,
    );
  }

  const connected = /语音已连接/u;
  await expect(pair.first.page.getByText(connected)).toBeVisible({
    timeout: 45_000,
  });
  await expect(pair.second.page.getByText(connected)).toBeVisible({
    timeout: 45_000,
  });
}

async function proveMicrophoneRevocationRecovery(
  pair: AcceptancePair,
): Promise<void> {
  const firstBefore = await waitForPeer(
    pair.first.page,
    (peer) => peer.connectionState === 'connected',
  );
  const secondBefore = await waitForPeer(
    pair.second.page,
    (peer) => peer.connectionState === 'connected',
  );
  const firstNegotiations = firstBefore.offers + firstBefore.answers;
  const secondNegotiations = secondBefore.offers + secondBefore.answers;
  const stopped = await pair.first.page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { stopLocalMicrophoneTrack(): number };
      }
    ).woAcceptanceControl.stopLocalMicrophoneTrack(),
  );
  expect(stopped).toBe(1);

  const endedError =
    pair.first.page.getByText('麦克风已断开，请检查权限或设备后重试');
  const retry = pair.first.page.getByRole('button', {
    name: '重试麦克风',
  });
  await expect(endedError).toBeVisible();
  await expect(retry).toBeVisible();
  await retry.click();

  await expect(endedError).toHaveCount(0);
  await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstBefore.id &&
      peer.offers + peer.answers === firstNegotiations &&
      peer.packetsSentAudio > firstBefore.packetsSentAudio &&
      peer.packetsReceivedAudio > firstBefore.packetsReceivedAudio,
  );
  await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondBefore.id &&
      peer.offers + peer.answers === secondNegotiations &&
      peer.packetsSentAudio > secondBefore.packetsSentAudio &&
      peer.packetsReceivedAudio > secondBefore.packetsReceivedAudio,
  );
}

async function proveBidirectionalAudio(pair: AcceptancePair): Promise<void> {
  const firstStart = await waitForPeer(
    pair.first.page,
    (peer, snapshot) =>
      peer.connectionState === 'connected' &&
      peer.liveRemoteAudioTracks === 1 &&
      peer.packetsReceivedAudio > 5 &&
      peer.packetsSentAudio > 5 &&
      peer.inboundAudioEnergy > 0 &&
      snapshot.rnnoiseActive &&
      snapshot.rnnoise.processorCreations > 0 &&
      snapshot.rnnoise.processedFrames > 0,
  );
  const secondStart = await waitForPeer(
    pair.second.page,
    (peer, snapshot) =>
      peer.connectionState === 'connected' &&
      peer.liveRemoteAudioTracks === 1 &&
      peer.packetsReceivedAudio > 5 &&
      peer.packetsSentAudio > 5 &&
      peer.inboundAudioEnergy > 0 &&
      snapshot.rnnoiseActive &&
      snapshot.rnnoise.processorCreations > 0 &&
      snapshot.rnnoise.processedFrames > 0,
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

async function proveNoiseIntensitySwitching(
  pair: AcceptancePair,
): Promise<NoiseIntensitySwitchReport> {
  const firstBaseline = await requiredDiagnostics(pair.first.page);
  const secondBaseline = await requiredDiagnostics(pair.second.page);
  const firstPeer = activePeer(firstBaseline);
  const secondPeer = activePeer(secondBaseline);
  if (firstPeer === null || secondPeer === null) {
    throw new Error('Connected peers are unavailable for RNNoise switching');
  }
  const firstNegotiations = firstPeer.offers + firstPeer.answers;
  const secondNegotiations = secondPeer.offers + secondPeer.answers;
  const firstProcessorCreations = firstBaseline.rnnoise.processorCreations;
  const secondProcessorCreations = secondBaseline.rnnoise.processorCreations;
  const cpu: Array<{
    intensity: 'light' | 'medium' | 'aggressive';
    first: AppCpuSample;
    second: AppCpuSample;
  }> = [];
  const settingsButton = pair.first.page.getByRole('button', { name: '设置' });
  await settingsButton.click();
  const settings = pair.first.page.getByRole('dialog', { name: '通话设置' });
  await expect(settings).toBeVisible();
  const selector = settings.getByLabel('麦克风降噪');
  await expect(selector).toHaveValue('light');

  // Electron CPUUsage is measured since the previous sample; the first call
  // establishes the baseline and intentionally reports zero.
  await Promise.all([
    cpuSample(pair.first.application),
    cpuSample(pair.second.application),
  ]);

  for (const intensity of ['medium', 'aggressive', 'light'] as const) {
    await Promise.all([
      resetRnnoiseCallbackGap(pair.first.page),
      resetRnnoiseCallbackGap(pair.second.page),
    ]);
    const firstBefore = await requiredDiagnostics(pair.first.page);
    const secondBefore = await requiredDiagnostics(pair.second.page);
    const firstPeerBefore = activePeer(firstBefore);
    const secondPeerBefore = activePeer(secondBefore);
    if (firstPeerBefore === null || secondPeerBefore === null) {
      throw new Error('Peer disappeared during RNNoise switching');
    }

    await selector.selectOption(intensity);
    await expect(selector).toHaveValue(intensity);
    await waitForPeer(
      pair.first.page,
      (peer, snapshot) =>
        peer.id === firstPeer.id &&
        peer.offers + peer.answers === firstNegotiations &&
        peer.packetsSentAudio > firstPeerBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > firstPeerBefore.packetsReceivedAudio &&
        snapshot.rnnoiseActive &&
        snapshot.rnnoise.processorCreations === firstProcessorCreations &&
        snapshot.rnnoise.processedFrames >
          firstBefore.rnnoise.processedFrames &&
        snapshot.rnnoise.audioProcessCallbacks >=
          firstBefore.rnnoise.audioProcessCallbacks + 2 &&
        snapshot.rnnoise.maxCallbackGapMs > 0 &&
        snapshot.rnnoise.maxCallbackGapMs <= maxRnnoiseCallbackGapMs,
    );
    await waitForPeer(
      pair.second.page,
      (peer, snapshot) =>
        peer.id === secondPeer.id &&
        peer.offers + peer.answers === secondNegotiations &&
        peer.packetsSentAudio > secondPeerBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > secondPeerBefore.packetsReceivedAudio &&
        snapshot.rnnoiseActive &&
        snapshot.rnnoise.processorCreations === secondProcessorCreations &&
        snapshot.rnnoise.processedFrames >
          secondBefore.rnnoise.processedFrames &&
        snapshot.rnnoise.audioProcessCallbacks >=
          secondBefore.rnnoise.audioProcessCallbacks + 2 &&
        snapshot.rnnoise.maxCallbackGapMs > 0 &&
        snapshot.rnnoise.maxCallbackGapMs <= maxRnnoiseCallbackGapMs,
    );
    cpu.push({
      intensity,
      first: await cpuSample(pair.first.application),
      second: await cpuSample(pair.second.application),
    });
  }

  const firstAfter = await requiredDiagnostics(pair.first.page);
  const secondAfter = await requiredDiagnostics(pair.second.page);
  await settingsButton.click();
  await expect(settings).toHaveCount(0);
  return {
    firstProcessorCreations,
    secondProcessorCreations,
    firstMaxCallbackGapMs: firstAfter.rnnoise.maxCallbackGapMs,
    secondMaxCallbackGapMs: secondAfter.rnnoise.maxCallbackGapMs,
    cpu,
  };
}

async function startMotionShare(
  page: Page,
  motionTitle: string,
  systemAudio = false,
): Promise<void> {
  await page.getByRole('button', { name: '共享屏幕' }).click();
  const dialog = page.getByRole('dialog', { name: '选择共享内容' });
  await expect(dialog).toBeVisible();
  if (systemAudio) {
    const toggle = dialog.getByRole('checkbox', { name: /共享系统音频/u });
    await toggle.check();
    await expect(toggle).toBeChecked();
  }
  const source = dialog.getByRole('button', {
    name: `${motionTitle}，窗口`,
    exact: true,
  });
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(4_500);
  await expect(source).toHaveAttribute('aria-pressed', 'true');
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

async function waitForActiveScreenAndSystemAudio(
  pair: AcceptancePair,
  input: {
    readonly transport: 'initial' | 'same' | 'new';
    readonly previous: Readonly<{
      first: PeerDiagnostic;
      second: PeerDiagnostic;
    }> | null;
    readonly expectedCaptureAttempts: number;
  },
) {
  const remoteVideo = pair.second.page.locator(
    'video[aria-label$="的共享屏幕"]',
  );
  await Promise.all([
    expect(pair.first.page.getByLabel('屏幕共享状态')).toBeVisible({
      timeout: 45_000,
    }),
    expect(remoteVideo).toBeVisible({ timeout: 45_000 }),
  ]);

  const matchesTransport = (
    peer: PeerDiagnostic,
    previous: PeerDiagnostic | undefined,
  ): boolean => {
    if (input.transport === 'initial') return true;
    if (previous === undefined) return false;
    if (input.transport === 'new') return peer.id !== previous.id;
    return (
      peer.id === previous.id &&
      peer.offers + peer.answers === previous.offers + previous.answers
    );
  };
  const firstFrames =
    input.transport === 'same' && input.previous !== null
      ? input.previous.first.framesSentVideo
      : 5;
  const secondFrames =
    input.transport === 'same' && input.previous !== null
      ? input.previous.second.framesReceivedVideo
      : 5;
  const firstSentAudio =
    input.transport === 'same' && input.previous !== null
      ? input.previous.first.packetsSentAudio
      : 5;
  const firstReceivedAudio =
    input.transport === 'same' && input.previous !== null
      ? input.previous.first.packetsReceivedAudio
      : 5;
  const secondSentAudio =
    input.transport === 'same' && input.previous !== null
      ? input.previous.second.packetsSentAudio
      : 5;
  const secondReceivedAudio =
    input.transport === 'same' && input.previous !== null
      ? input.previous.second.packetsReceivedAudio
      : 5;

  const [first, second] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer, snapshot) =>
        matchesTransport(peer, input.previous?.first) &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks === 1 &&
        peer.packetsSentAudio > firstSentAudio &&
        peer.packetsReceivedAudio > firstReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        peer.framesSentVideo > firstFrames &&
        peer.bytesSentVideo > 0 &&
        peer.screenWidth >= 1_920 &&
        peer.screenHeight >= 1_080 &&
        peer.screenFrameRate >= 55 &&
        matchesIcePolicy(peer, 'relay') &&
        snapshot.capture.attempts === input.expectedCaptureAttempts &&
        snapshot.capture.successes === input.expectedCaptureAttempts &&
        snapshot.capture.videoTracks === 1 &&
        snapshot.capture.audioTracks === 1 &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 1,
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer, snapshot) =>
        matchesTransport(peer, input.previous?.second) &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks === 2 &&
        peer.liveRemoteVideoTracks === 1 &&
        peer.packetsSentAudio > secondSentAudio &&
        peer.packetsReceivedAudio > secondReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        peer.framesReceivedVideo > secondFrames &&
        peer.bytesReceivedVideo > 0 &&
        matchesIcePolicy(peer, 'relay') &&
        snapshot.capture.attempts === 0 &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 0,
      60_000,
    ),
  ]);
  const [firstProgress, secondProgress] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer, snapshot) =>
        peer.id === first.id &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > first.packetsSentAudio &&
        peer.packetsReceivedAudio > first.packetsReceivedAudio &&
        peer.framesSentVideo > first.framesSentVideo &&
        peer.bytesSentVideo > first.bytesSentVideo &&
        snapshot.capture.attempts === input.expectedCaptureAttempts &&
        snapshot.capture.successes === input.expectedCaptureAttempts &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 1,
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer, snapshot) =>
        peer.id === second.id &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > second.packetsSentAudio &&
        peer.packetsReceivedAudio > second.packetsReceivedAudio &&
        peer.framesReceivedVideo > second.framesReceivedVideo &&
        peer.bytesReceivedVideo > second.bytesReceivedVideo &&
        snapshot.capture.attempts === 0 &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 0,
      60_000,
    ),
  ]);
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    requiredDiagnostics(pair.first.page),
    requiredDiagnostics(pair.second.page),
  ]);
  return {
    first: firstProgress,
    second: secondProgress,
    firstCapture: firstSnapshot.capture,
    firstResources: firstSnapshot.resources,
    secondResources: secondSnapshot.resources,
  };
}

async function waitForLifecycleCaptureActive(
  pair: AcceptancePair,
  input: {
    readonly previous: Readonly<{
      first: PeerDiagnostic;
      second: PeerDiagnostic;
    }> | null;
    readonly expectedCaptureAttempts: number;
    readonly expectedRemoteCaptureAttempts: number;
  },
) {
  await Promise.all([
    expect(pair.first.page.getByLabel('屏幕共享状态')).toBeVisible({
      timeout: 45_000,
    }),
    expect(
      pair.second.page.locator('video[aria-label$="的共享屏幕"]'),
    ).toBeVisible({ timeout: 45_000 }),
  ]);
  const matchesPrevious = (
    peer: PeerDiagnostic,
    previous: PeerDiagnostic | undefined,
  ): boolean =>
    previous === undefined ||
    (peer.id === previous.id &&
      peer.offers + peer.answers === previous.offers + previous.answers);
  const [first, second] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer, snapshot) =>
        matchesPrevious(peer, input.previous?.first) &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks >= 1 &&
        peer.packetsSentAudio > 5 &&
        peer.packetsReceivedAudio > 5 &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay') &&
        snapshot.capture.attempts === input.expectedCaptureAttempts &&
        snapshot.capture.successes === input.expectedCaptureAttempts &&
        snapshot.capture.videoTracks === 1 &&
        snapshot.capture.audioTracks === 1 &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 1,
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer, snapshot) =>
        matchesPrevious(peer, input.previous?.second) &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks === 2 &&
        peer.liveRemoteVideoTracks === 1 &&
        peer.packetsSentAudio > 5 &&
        peer.packetsReceivedAudio > 5 &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay') &&
        snapshot.capture.attempts === input.expectedRemoteCaptureAttempts &&
        snapshot.resources.activePeerConnections === 1 &&
        snapshot.resources.liveMicrophoneTracks === 1 &&
        snapshot.resources.liveSystemAudioTracks === 0,
      60_000,
    ),
  ]);
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    requiredDiagnostics(pair.first.page),
    requiredDiagnostics(pair.second.page),
  ]);
  return {
    first,
    second,
    firstCapture: firstSnapshot.capture,
    firstResources: firstSnapshot.resources,
    secondResources: secondSnapshot.resources,
  };
}

async function emitCaptureLifecycleEvent(
  application: ElectronApplication,
  event: 'lock-screen' | 'suspend',
): Promise<void> {
  const emitted = await application.evaluate(
    ({ powerMonitor }, eventName) => powerMonitor.emit(eventName),
    event,
  );
  expect(emitted).toBe(true);
}

async function waitForLifecycleShareStopped(
  pair: AcceptancePair,
  input: {
    readonly previous: Readonly<{
      first: PeerDiagnostic;
      second: PeerDiagnostic;
    }>;
    readonly expectedCaptureAttempts: number;
  },
) {
  await Promise.all([
    expect(pair.first.page.getByLabel('屏幕共享状态')).toHaveCount(0, {
      timeout: 30_000,
    }),
    expect(
      pair.second.page.locator('video[aria-label$="的共享屏幕"]'),
    ).toHaveCount(0, { timeout: 30_000 }),
  ]);
  const [first, second] = await waitForSameTransportAudioRecovery(
    pair,
    'relay',
    input.previous.first,
    input.previous.second,
  );
  await expect
    .poll(
      async () => {
        const [sharer, receiver] = await Promise.all([
          requiredDiagnostics(pair.first.page),
          requiredDiagnostics(pair.second.page),
        ]);
        return {
          captureAttempts: sharer.capture.attempts,
          sharer: sharer.resources,
          receiver: receiver.resources,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      captureAttempts: input.expectedCaptureAttempts,
      sharer: {
        activePeerConnections: 1,
        openSignalingSockets: 1,
        liveMicrophoneTracks: 1,
        liveSystemAudioTracks: 0,
        activeRnnoiseAudioContexts: 1,
      },
      receiver: {
        activePeerConnections: 1,
        openSignalingSockets: 1,
        liveMicrophoneTracks: 1,
        liveSystemAudioTracks: 0,
        activeRnnoiseAudioContexts: 1,
      },
    });
  const [sharerSnapshot, receiverSnapshot] = await Promise.all([
    requiredDiagnostics(pair.first.page),
    requiredDiagnostics(pair.second.page),
  ]);
  return {
    first,
    second,
    sharerCapture: sharerSnapshot.capture,
    sharerResources: sharerSnapshot.resources,
    receiverResources: receiverSnapshot.resources,
  };
}

async function proveOwnerProcessRelease(
  pair: AcceptancePair,
  input: {
    readonly mode: 'exit' | 'crash';
    readonly active: Awaited<ReturnType<typeof waitForLifecycleCaptureActive>>;
  },
) {
  const availableShareButton = pair.second.page.getByRole('button', {
    name: '共享屏幕',
  });
  await expect(availableShareButton).toHaveCount(0);

  const terminationStartedAtMs = Date.now();
  const termination =
    input.mode === 'exit' ? pair.first.close() : pair.first.crash();
  const buttonAvailable = (async () => {
    await expect(availableShareButton).toBeVisible({
      timeout: input.mode === 'exit' ? 15_000 : 30_000,
    });
    await expect(availableShareButton).toBeEnabled();
    return Date.now() - terminationStartedAtMs;
  })();

  const [, buttonAvailableAfterMs] = await Promise.all([
    termination,
    buttonAvailable,
    expect(
      pair.second.page.locator('video[aria-label$="的共享屏幕"]'),
    ).toHaveCount(0, { timeout: 30_000 }),
    expect(pair.second.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    }),
    expect(pair.second.page.locator('[title="离线"]')).toBeVisible({
      timeout: 30_000,
    }),
  ]);
  expect(buttonAvailableAfterMs).toBeLessThan(
    input.mode === 'exit' ? 15_000 : 30_000,
  );

  const survivorAfterDeparture = await waitForPeer(
    pair.second.page,
    (peer, snapshot) =>
      peer.id === input.active.second.id &&
      snapshot.capture.attempts === 0 &&
      snapshot.resources.activePeerConnections === 1 &&
      snapshot.resources.openSignalingSockets === 1 &&
      snapshot.resources.liveMicrophoneTracks === 1 &&
      snapshot.resources.liveSystemAudioTracks === 0 &&
      snapshot.resources.activeRnnoiseAudioContexts === 1,
    30_000,
  );

  await startMotionShare(pair.second.page, pair.motionTitle, true);
  const leaseAcquiredAfterMs = Date.now() - terminationStartedAtMs;
  if (input.mode === 'exit') {
    expect(leaseAcquiredAfterMs).toBeLessThan(15_000);
  } else {
    expect(leaseAcquiredAfterMs).toBeLessThan(30_000);
  }
  const survivorAcquired = await waitForPeer(
    pair.second.page,
    (peer, snapshot) =>
      peer.id === survivorAfterDeparture.id &&
      snapshot.capture.attempts === 1 &&
      snapshot.capture.successes === 1 &&
      snapshot.capture.videoTracks === 1 &&
      snapshot.capture.audioTracks === 1 &&
      snapshot.capture.width > 0 &&
      snapshot.capture.height > 0 &&
      snapshot.resources.activePeerConnections === 1 &&
      snapshot.resources.openSignalingSockets === 1 &&
      snapshot.resources.liveMicrophoneTracks === 1 &&
      snapshot.resources.liveSystemAudioTracks === 1 &&
      snapshot.resources.activeRnnoiseAudioContexts === 1,
    30_000,
  );

  await pair.second.page.getByRole('button', { name: '停止共享' }).click();
  await expect(pair.second.page.getByLabel('屏幕共享状态')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect
    .poll(
      async () =>
        (await requiredDiagnostics(pair.second.page)).resources
          .liveSystemAudioTracks,
      { timeout: 30_000 },
    )
    .toBe(0);

  return {
    mode: input.mode,
    buttonAvailableAfterMs,
    leaseAcquiredAfterMs,
    ownerBefore: input.active.first,
    survivorBefore: input.active.second,
    survivorAfterDeparture,
    survivorAcquired,
  };
}

async function proveRemoteAudioTrackIsolation(pair: AcceptancePair) {
  const firstWithBoth = await waitForPeer(
    pair.first.page,
    (peer, snapshot) =>
      snapshot.capture.audioTracks === 1 &&
      peer.connectionState === 'connected' &&
      peer.packetsSentAudio > 5 &&
      peer.framesSentVideo > 5 &&
      peer.localAudioEnergy > 0,
  );
  const secondWithBoth = await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.connectionState === 'connected' &&
      peer.liveRemoteAudioTracks === 2 &&
      peer.packetsReceivedAudio > 5 &&
      peer.framesReceivedVideo > 5 &&
      peer.inboundAudioEnergy > 0,
  );
  const firstNegotiations = firstWithBoth.offers + firstWithBoth.answers;
  const secondNegotiations = secondWithBoth.offers + secondWithBoth.answers;

  const stoppedMicrophone = await pair.first.page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { stopLocalMicrophoneTrack(): number };
      }
    ).woAcceptanceControl.stopLocalMicrophoneTrack(),
  );
  expect(stoppedMicrophone).toBe(1);
  const microphoneEnded =
    pair.first.page.getByText('麦克风已断开，请检查权限或设备后重试');
  await expect(microphoneEnded).toBeVisible();
  const firstSystemOnly = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstWithBoth.id &&
      peer.offers + peer.answers === firstNegotiations &&
      peer.packetsSentAudio > firstWithBoth.packetsSentAudio &&
      peer.framesSentVideo > firstWithBoth.framesSentVideo &&
      peer.localAudioEnergy > 0,
  );
  const secondSystemOnly = await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondWithBoth.id &&
      peer.offers + peer.answers === secondNegotiations &&
      peer.liveRemoteAudioTracks >= 1 &&
      peer.packetsReceivedAudio > secondWithBoth.packetsReceivedAudio &&
      peer.bytesReceivedAudio > secondWithBoth.bytesReceivedAudio &&
      peer.framesReceivedVideo > secondWithBoth.framesReceivedVideo &&
      peer.inboundAudioEnergy > 0,
  );

  await pair.first.page.getByRole('button', { name: '重试麦克风' }).click();
  await expect(microphoneEnded).toHaveCount(0);
  const firstRestored = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstWithBoth.id &&
      peer.offers + peer.answers === firstNegotiations &&
      peer.packetsSentAudio > firstSystemOnly.packetsSentAudio,
  );
  const secondRestored = await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondWithBoth.id &&
      peer.offers + peer.answers === secondNegotiations &&
      peer.liveRemoteAudioTracks === 2 &&
      peer.packetsReceivedAudio > secondSystemOnly.packetsReceivedAudio,
  );

  const stoppedSystemAudio = await pair.first.page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { stopLocalSystemAudioTrack(): number };
      }
    ).woAcceptanceControl.stopLocalSystemAudioTrack(),
  );
  expect(stoppedSystemAudio).toBe(1);
  await expect(pair.first.page.getByLabel('屏幕共享状态')).toBeVisible();
  const firstMicrophoneOnly = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id === firstWithBoth.id &&
      peer.offers + peer.answers === firstNegotiations &&
      peer.packetsSentAudio > firstRestored.packetsSentAudio &&
      peer.framesSentVideo > firstRestored.framesSentVideo &&
      peer.localAudioEnergy > 0,
  );
  const secondMicrophoneOnly = await waitForPeer(
    pair.second.page,
    (peer) =>
      peer.id === secondWithBoth.id &&
      peer.offers + peer.answers === secondNegotiations &&
      peer.liveRemoteAudioTracks >= 1 &&
      peer.packetsReceivedAudio > secondRestored.packetsReceivedAudio &&
      peer.bytesReceivedAudio > secondRestored.bytesReceivedAudio &&
      peer.framesReceivedVideo > secondRestored.framesReceivedVideo &&
      peer.inboundAudioEnergy > 0,
  );

  return {
    firstWithBoth,
    secondWithBoth,
    firstSystemOnly,
    secondSystemOnly,
    firstMicrophoneOnly,
    secondMicrophoneOnly,
  };
}

async function proveScreenAndBitrates(pair: AcceptancePair) {
  await startMotionShare(pair.first.page, pair.motionTitle, true);
  const remoteVideo = pair.second.page.locator(
    'video[aria-label$="的共享屏幕"]',
  );
  await expect(remoteVideo).toBeVisible({ timeout: 45_000 });
  const remoteAudioIsolation = await proveRemoteAudioTrackIsolation(pair);
  const initial = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.screenWidth >= 1920 &&
      peer.screenHeight >= 1080 &&
      Math.abs(peer.screenWidth / peer.screenHeight - 16 / 9) < 0.02 &&
      peer.screenFrameRate >= 55 &&
      peer.framesSentVideo > 5,
  );
  await waitForPeer(
    pair.second.page,
    (peer) => peer.framesReceivedVideo > 5 && peer.liveRemoteVideoTracks === 1,
  );
  const negotiationCount = initial.offers + initial.answers;

  for (const [label, bitrate] of [
    ['清晰 5M', 5_000_000],
    ['高清 10M', 10_000_000],
    ['原画 20M', 20_000_000],
  ] as const) {
    const remoteBefore = await waitForPeer(pair.second.page, () => true);
    await pair.first.page.getByLabel('码率上限').selectOption({ label });
    await expect(pair.first.page.getByLabel('码率上限')).toHaveValue(
      String(bitrate),
    );
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
  return remoteAudioIsolation;
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

async function dropSignaling(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { dropSignaling(): number };
      }
    ).woAcceptanceControl.dropSignaling(),
  );
}

async function pauseSignaling(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { pauseSignaling(): number };
      }
    ).woAcceptanceControl.pauseSignaling(),
  );
}

async function resumeSignaling(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: { resumeSignaling(): number };
      }
    ).woAcceptanceControl.resumeSignaling(),
  );
}

async function pauseScreenLeaseMaintenance(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: {
          pauseScreenLeaseMaintenance(): number;
        };
      }
    ).woAcceptanceControl.pauseScreenLeaseMaintenance(),
  );
}

async function resumeScreenLeaseMaintenance(page: Page): Promise<number> {
  return page.evaluate(() =>
    (
      window as unknown as {
        woAcceptanceControl: {
          resumeScreenLeaseMaintenance(): number;
        };
      }
    ).woAcceptanceControl.resumeScreenLeaseMaintenance(),
  );
}

function matchesIcePolicy(
  peer: PeerDiagnostic,
  policy: AcceptancePolicy,
): boolean {
  if (policy === 'relay') {
    return peer.localIceType === 'relay' && peer.remoteIceType === 'relay';
  }
  return (
    peer.localIceType !== '' &&
    peer.remoteIceType !== '' &&
    peer.localIceType !== 'relay' &&
    peer.remoteIceType !== 'relay'
  );
}

async function expectParticipantsIntact(
  pair: AcceptancePair,
  creatorName: string,
  joinerName: string,
): Promise<void> {
  await Promise.all([
    expect(pair.first.page.getByTestId('participant-slot')).toHaveCount(2),
    expect(pair.second.page.getByTestId('participant-slot')).toHaveCount(2),
    expect(
      pair.first.page.getByTitle(joinerName, { exact: true }),
    ).toBeVisible(),
    expect(
      pair.second.page.getByTitle(creatorName, { exact: true }),
    ).toBeVisible(),
    expect(pair.first.page.getByText('语音连接异常')).toHaveCount(0),
    expect(pair.second.page.getByText('语音连接异常')).toHaveCount(0),
  ]);
}

async function expectConnectedParticipants(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
  creatorName: string,
  joinerName: string,
): Promise<void> {
  const connectedLabel =
    policy === 'relay' ? '语音已连接（中继）' : '语音已连接';
  await Promise.all([
    expect(
      pair.first.page.getByText(connectedLabel, { exact: true }),
    ).toBeVisible({ timeout: 45_000 }),
    expect(
      pair.second.page.getByText(connectedLabel, { exact: true }),
    ).toBeVisible({ timeout: 45_000 }),
  ]);
  await expectParticipantsIntact(pair, creatorName, joinerName);
}

function expectSignalingUnchanged(
  before: AcceptanceSnapshot,
  after: AcceptanceSnapshot,
): void {
  expect(after.signalingDrops).toBe(before.signalingDrops);
  expect(after.signalingPaused).toBe(false);
  expect(after.blockedSignalingAttempts).toBe(before.blockedSignalingAttempts);
  expect(after.sockets).toHaveLength(before.sockets.length);
  for (const socket of before.sockets) {
    const current = after.sockets.find(
      (candidate) => candidate.id === socket.id,
    );
    expect(current).toBeDefined();
    expect(current?.opens).toBe(socket.opens);
    expect(current?.closes).toBe(socket.closes);
    expect(current?.state).toBe(socket.state);
    expect(current?.lastCloseCode).toBe(socket.lastCloseCode);
    expect(current?.lastCloseReason).toBe(socket.lastCloseReason);
  }
}

async function waitForSameTransportAudioRecovery(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
  firstBefore: PeerDiagnostic,
  secondBefore: PeerDiagnostic,
): Promise<readonly [PeerDiagnostic, PeerDiagnostic]> {
  const firstNegotiations = firstBefore.offers + firstBefore.answers;
  const secondNegotiations = secondBefore.offers + secondBefore.answers;
  const recovered = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstBefore.id &&
        peer.offers + peer.answers === firstNegotiations &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > firstBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > firstBefore.packetsReceivedAudio &&
        peer.bytesSentAudio > firstBefore.bytesSentAudio &&
        peer.bytesReceivedAudio > firstBefore.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, policy),
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondBefore.id &&
        peer.offers + peer.answers === secondNegotiations &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > secondBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > secondBefore.packetsReceivedAudio &&
        peer.bytesSentAudio > secondBefore.bytesSentAudio &&
        peer.bytesReceivedAudio > secondBefore.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, policy),
      60_000,
    ),
  ]);
  return recovered;
}

async function proveRelayIceRestart(
  pair: AcceptancePair,
): Promise<IceRestartRecoveryReport> {
  const creatorName = 'Alice-relay';
  const joinerName = 'Bob-relay';
  const [firstBefore, secondBefore, firstSnapshotBefore, secondSnapshotBefore] =
    await Promise.all([
      waitForPeer(pair.first.page, (peer) => matchesIcePolicy(peer, 'relay')),
      waitForPeer(pair.second.page, (peer) => matchesIcePolicy(peer, 'relay')),
      requiredDiagnostics(pair.first.page),
      requiredDiagnostics(pair.second.page),
    ]);

  const unpause = await pauseIntegrationCoturn();
  const {
    firstDuring,
    secondDuring,
    firstStatusDuring,
    secondStatusDuring,
    firstStatusHistoryDuring,
    secondStatusHistoryDuring,
  } = await (async () => {
    try {
      const [currentFirst, currentSecond] = await Promise.all([
        waitForPeerDiagnostic(
          pair.first.page,
          firstBefore.id,
          (peer, snapshot) =>
            peer.iceConnectionStateHistory.includes('disconnected') &&
            peer.restartIceCalls > firstBefore.restartIceCalls &&
            snapshot.callStatusHistory.includes('reconnecting'),
          60_000,
        ),
        waitForPeerDiagnostic(
          pair.second.page,
          secondBefore.id,
          (peer, snapshot) =>
            peer.iceConnectionStateHistory.includes('disconnected') &&
            snapshot.callStatusHistory.includes('reconnecting'),
          60_000,
        ),
      ]);
      await expectParticipantsIntact(pair, creatorName, joinerName);
      const [firstStatus, secondStatus] = await Promise.all([
        connectionStatus(pair.first.page),
        connectionStatus(pair.second.page),
      ]);
      const [firstSnapshotDuring, secondSnapshotDuring] = await Promise.all([
        requiredDiagnostics(pair.first.page),
        requiredDiagnostics(pair.second.page),
      ]);
      expectSignalingUnchanged(firstSnapshotBefore, firstSnapshotDuring);
      expectSignalingUnchanged(secondSnapshotBefore, secondSnapshotDuring);
      return {
        firstDuring: currentFirst,
        secondDuring: currentSecond,
        firstStatusDuring: firstStatus,
        secondStatusDuring: secondStatus,
        firstStatusHistoryDuring: firstSnapshotDuring.callStatusHistory,
        secondStatusHistoryDuring: secondSnapshotDuring.callStatusHistory,
      };
    } finally {
      await unpause();
    }
  })();

  const [firstReconnected, secondReconnected] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstBefore.id &&
        peer.connectionState === 'connected' &&
        (peer.iceConnectionState === 'connected' ||
          peer.iceConnectionState === 'completed') &&
        peer.restartIceCalls > firstBefore.restartIceCalls &&
        peer.offers + peer.answers > firstBefore.offers + firstBefore.answers &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondBefore.id &&
        peer.connectionState === 'connected' &&
        (peer.iceConnectionState === 'connected' ||
          peer.iceConnectionState === 'completed') &&
        peer.offers + peer.answers >
          secondBefore.offers + secondBefore.answers &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
  ]);
  const [firstAfter, secondAfter] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstReconnected.id &&
        peer.packetsSentAudio > firstReconnected.packetsSentAudio &&
        peer.packetsReceivedAudio > firstReconnected.packetsReceivedAudio &&
        peer.bytesSentAudio > firstReconnected.bytesSentAudio &&
        peer.bytesReceivedAudio > firstReconnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondReconnected.id &&
        peer.packetsSentAudio > secondReconnected.packetsSentAudio &&
        peer.packetsReceivedAudio > secondReconnected.packetsReceivedAudio &&
        peer.bytesSentAudio > secondReconnected.bytesSentAudio &&
        peer.bytesReceivedAudio > secondReconnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
  ]);
  const [firstSnapshotAfter, secondSnapshotAfter] = await Promise.all([
    requiredDiagnostics(pair.first.page),
    requiredDiagnostics(pair.second.page),
  ]);
  expectSignalingUnchanged(firstSnapshotBefore, firstSnapshotAfter);
  expectSignalingUnchanged(secondSnapshotBefore, secondSnapshotAfter);

  return {
    firstBefore,
    secondBefore,
    firstDuring,
    secondDuring,
    firstAfter,
    secondAfter,
    firstStatusDuring,
    secondStatusDuring,
    firstStatusHistoryDuring,
    secondStatusHistoryDuring,
  };
}

async function proveRelayIceFailureReset(
  pair: AcceptancePair,
): Promise<IceResetRecoveryReport> {
  const creatorName = 'Alice-relay';
  const joinerName = 'Bob-relay';
  const [firstBefore, secondBefore, firstSnapshotBefore, secondSnapshotBefore] =
    await Promise.all([
      waitForPeer(pair.first.page, (peer) => matchesIcePolicy(peer, 'relay')),
      waitForPeer(pair.second.page, (peer) => matchesIcePolicy(peer, 'relay')),
      requiredDiagnostics(pair.first.page),
      requiredDiagnostics(pair.second.page),
    ]);

  const [heldFirstPeerId, heldSecondPeerId] = await Promise.all([
    holdDisconnectedIceEvents(pair.first.page),
    holdDisconnectedIceEvents(pair.second.page),
  ]);
  expect(heldFirstPeerId).toBe(firstBefore.id);
  expect(heldSecondPeerId).toBe(secondBefore.id);

  const unpause = await pauseIntegrationCoturn();
  const {
    firstFailed,
    secondFailed,
    firstClosed,
    secondClosed,
    firstReset,
    secondReset,
    firstStatusHistoryDuring,
    secondStatusHistoryDuring,
  } = await (async () => {
    try {
      const [failedFirst, failedSecond] = await Promise.all([
        waitForPeerDiagnostic(
          pair.first.page,
          firstBefore.id,
          (peer, snapshot) =>
            peer.iceConnectionStateHistory.includes('disconnected') &&
            peer.connectionStateHistory.includes('failed') &&
            peer.heldDisconnectedIceEvents >
              firstBefore.heldDisconnectedIceEvents &&
            !peer.holdDisconnectedIceEvents &&
            peer.restartIceCalls > firstBefore.restartIceCalls &&
            snapshot.callStatusHistory.includes('reconnecting'),
          120_000,
        ),
        waitForPeerDiagnostic(
          pair.second.page,
          secondBefore.id,
          (peer, snapshot) =>
            peer.iceConnectionStateHistory.includes('disconnected') &&
            peer.connectionStateHistory.includes('failed') &&
            peer.heldDisconnectedIceEvents >
              secondBefore.heldDisconnectedIceEvents &&
            !peer.holdDisconnectedIceEvents &&
            snapshot.callStatusHistory.includes('reconnecting'),
          120_000,
        ),
      ]);
      await expectParticipantsIntact(pair, creatorName, joinerName);
      const [closedFirst, closedSecond] = await Promise.all([
        waitForPeerDiagnostic(
          pair.first.page,
          firstBefore.id,
          (peer) => peer.closed,
          45_000,
        ),
        waitForPeerDiagnostic(
          pair.second.page,
          secondBefore.id,
          (peer) => peer.closed,
          45_000,
        ),
      ]);
      const [resetFirst, resetSecond] = await Promise.all([
        waitForPeer(
          pair.first.page,
          (peer) =>
            peer.id !== firstBefore.id &&
            !peer.closed &&
            peer.transceivers === 3,
          45_000,
        ),
        waitForPeer(
          pair.second.page,
          (peer) =>
            peer.id !== secondBefore.id &&
            !peer.closed &&
            peer.transceivers === 3,
          45_000,
        ),
      ]);
      const [firstSnapshotDuring, secondSnapshotDuring] = await Promise.all([
        requiredDiagnostics(pair.first.page),
        requiredDiagnostics(pair.second.page),
      ]);
      expectSignalingUnchanged(firstSnapshotBefore, firstSnapshotDuring);
      expectSignalingUnchanged(secondSnapshotBefore, secondSnapshotDuring);
      return {
        firstFailed: failedFirst,
        secondFailed: failedSecond,
        firstClosed: closedFirst,
        secondClosed: closedSecond,
        firstReset: resetFirst,
        secondReset: resetSecond,
        firstStatusHistoryDuring: firstSnapshotDuring.callStatusHistory,
        secondStatusHistoryDuring: secondSnapshotDuring.callStatusHistory,
      };
    } finally {
      await unpause();
    }
  })();

  const [firstReconnected, secondReconnected] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstReset.id &&
        peer.connectionState === 'connected' &&
        peer.transceivers === 3 &&
        peer.offers > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondReset.id &&
        peer.connectionState === 'connected' &&
        peer.transceivers === 3 &&
        peer.answers > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
  ]);
  const [firstAfter, secondAfter] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === firstReconnected.id &&
        peer.packetsSentAudio > firstReconnected.packetsSentAudio &&
        peer.packetsReceivedAudio > firstReconnected.packetsReceivedAudio &&
        peer.bytesSentAudio > firstReconnected.bytesSentAudio &&
        peer.bytesReceivedAudio > firstReconnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === secondReconnected.id &&
        peer.packetsSentAudio > secondReconnected.packetsSentAudio &&
        peer.packetsReceivedAudio > secondReconnected.packetsReceivedAudio &&
        peer.bytesSentAudio > secondReconnected.bytesSentAudio &&
        peer.bytesReceivedAudio > secondReconnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0 &&
        matchesIcePolicy(peer, 'relay'),
      60_000,
    ),
  ]);
  const [firstSnapshotAfter, secondSnapshotAfter] = await Promise.all([
    requiredDiagnostics(pair.first.page),
    requiredDiagnostics(pair.second.page),
  ]);
  expectSignalingUnchanged(firstSnapshotBefore, firstSnapshotAfter);
  expectSignalingUnchanged(secondSnapshotBefore, secondSnapshotAfter);

  return {
    firstBefore,
    secondBefore,
    firstFailed,
    secondFailed,
    firstClosed,
    secondClosed,
    firstReset,
    secondReset,
    firstAfter,
    secondAfter,
    firstSnapshotAfter,
    secondSnapshotAfter,
    firstStatusHistoryDuring,
    secondStatusHistoryDuring,
  };
}

async function proveV09SignalingRecovery(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
): Promise<SignalingRecoveryReport> {
  const creatorName = `Alice-${policy}`;
  const joinerName = `Bob-${policy}`;
  const [shortFirstBefore, shortSecondBefore, firstSnapshotBefore] =
    await Promise.all([
      waitForPeer(pair.first.page, () => true),
      waitForPeer(pair.second.page, () => true),
      requiredDiagnostics(pair.first.page),
    ]);

  expect(await dropSignaling(pair.first.page)).toBe(1);
  await expectConnectedParticipants(pair, policy, creatorName, joinerName);
  await expect
    .poll(
      async () => {
        const snapshot = await requiredDiagnostics(pair.first.page);
        return (
          snapshot.signalingDrops === firstSnapshotBefore.signalingDrops + 1 &&
          snapshot.sockets.length > firstSnapshotBefore.sockets.length &&
          snapshot.sockets.some(
            (socket) => socket.opens > 0 && socket.closes > 0,
          ) &&
          snapshot.sockets.some(
            (socket) => socket.opens > 0 && socket.closes === 0,
          )
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const [shortFirstAfter, shortSecondAfter] =
    await waitForSameTransportAudioRecovery(
      pair,
      policy,
      shortFirstBefore,
      shortSecondBefore,
    );
  await expectConnectedParticipants(pair, policy, creatorName, joinerName);

  const [longFirstBefore, longSecondBefore, secondSnapshotBefore] =
    await Promise.all([
      waitForPeer(pair.first.page, () => true),
      waitForPeer(pair.second.page, () => true),
      requiredDiagnostics(pair.second.page),
    ]);
  const pauseStartedAt = Date.now();
  expect(await pauseSignaling(pair.second.page)).toBe(1);
  await Promise.all([
    expect(pair.first.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    }),
    expect(pair.first.page.locator('[title="离线"]')).toBeVisible({
      timeout: 30_000,
    }),
    expect(pair.second.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    }),
  ]);
  await Promise.all([
    expect(pair.first.page.getByTestId('participant-slot')).toHaveCount(2),
    expect(pair.second.page.getByTestId('participant-slot')).toHaveCount(2),
    expect(
      pair.first.page.getByTitle(joinerName, { exact: true }),
    ).toBeVisible(),
    expect(
      pair.second.page.getByTitle(creatorName, { exact: true }),
    ).toBeVisible(),
    expect(pair.first.page.getByText('语音连接异常')).toHaveCount(0),
    expect(pair.second.page.getByText('语音连接异常')).toHaveCount(0),
  ]);
  await expect
    .poll(
      async () => {
        const snapshot = await requiredDiagnostics(pair.second.page);
        return (
          snapshot.signalingPaused &&
          snapshot.sockets.length === secondSnapshotBefore.sockets.length &&
          snapshot.blockedSignalingAttempts -
            secondSnapshotBefore.blockedSignalingAttempts >=
            5
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const pauseDurationMs = Date.now() - pauseStartedAt;
  expect(pauseDurationMs).toBeGreaterThanOrEqual(3_500);
  const [firstDuring, secondDuring] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === longFirstBefore.id &&
        peer.offers + peer.answers ===
          longFirstBefore.offers + longFirstBefore.answers &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > longFirstBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > longFirstBefore.packetsReceivedAudio &&
        matchesIcePolicy(peer, policy),
      10_000,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === longSecondBefore.id &&
        peer.offers + peer.answers ===
          longSecondBefore.offers + longSecondBefore.answers &&
        peer.connectionState === 'connected' &&
        peer.packetsSentAudio > longSecondBefore.packetsSentAudio &&
        peer.packetsReceivedAudio > longSecondBefore.packetsReceivedAudio &&
        matchesIcePolicy(peer, policy),
      10_000,
    ),
  ]);

  expect(await resumeSignaling(pair.second.page)).toBe(1);
  await expectConnectedParticipants(pair, policy, creatorName, joinerName);
  const [longFirstAfter, longSecondAfter] =
    await waitForSameTransportAudioRecovery(
      pair,
      policy,
      firstDuring,
      secondDuring,
    );
  const recoveredSnapshot = await requiredDiagnostics(pair.second.page);
  expect(recoveredSnapshot.signalingPaused).toBe(false);
  expect(await resumeSignaling(pair.second.page)).toBe(0);
  const blockedAttempts =
    recoveredSnapshot.blockedSignalingAttempts -
    secondSnapshotBefore.blockedSignalingAttempts;
  expect(blockedAttempts).toBeGreaterThanOrEqual(5);

  return {
    short: {
      firstBefore: shortFirstBefore,
      secondBefore: shortSecondBefore,
      firstAfter: shortFirstAfter,
      secondAfter: shortSecondAfter,
    },
    long: {
      firstBefore: longFirstBefore,
      secondBefore: longSecondBefore,
      firstDuring,
      secondDuring,
      firstAfter: longFirstAfter,
      secondAfter: longSecondAfter,
      blockedAttempts,
      pauseDurationMs,
    },
  };
}

async function leaveJoinerExplicitly(
  pair: AcceptancePair,
  departedName: string,
): Promise<ExplicitDepartureReport> {
  const [creatorBeforeLeave, joinerBeforeLeave] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) => peer.connectionState === 'connected',
    ),
    waitForPeer(
      pair.second.page,
      (peer) => peer.connectionState === 'connected',
    ),
  ]);

  await pair.second.page.getByRole('button', { name: '挂断' }).click();
  await Promise.all([
    expect(
      pair.second.page.getByRole('button', { name: '创建房间' }),
    ).toBeVisible({ timeout: 45_000 }),
    expect(
      pair.first.page.getByText('等待对方加入', { exact: true }),
    ).toBeVisible({ timeout: 45_000 }),
    expect(pair.first.page.getByTestId('participant-waiting')).toBeVisible({
      timeout: 45_000,
    }),
  ]);
  await Promise.all([
    expect(pair.first.page.getByTestId('participant-slot')).toHaveCount(1),
    expect(
      pair.first.page.getByTitle(departedName, { exact: true }),
    ).toHaveCount(0),
    expect(pair.first.page.getByText('语音连接异常')).toHaveCount(0),
  ]);

  const [creatorClosed, joinerClosed, creatorWaiting] = await Promise.all([
    waitForClosedPeer(pair.first.page, creatorBeforeLeave.id),
    waitForClosedPeer(pair.second.page, joinerBeforeLeave.id),
    waitForPeer(
      pair.first.page,
      (peer, snapshot) =>
        peer.id !== creatorBeforeLeave.id &&
        peer.transceivers === 3 &&
        peer.connectionState !== 'failed' &&
        snapshot.peers.some(
          (candidate) =>
            candidate.id === creatorBeforeLeave.id && candidate.closed,
        ),
    ),
  ]);

  return {
    creatorBeforeLeave,
    joinerBeforeLeave,
    creatorClosed,
    joinerClosed,
    creatorWaiting,
  };
}

async function joinExistingRoomAndProveAudio(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
  roomCode: string,
  creatorName: string,
  joinerName: string,
  departure: ExplicitDepartureReport,
): Promise<ExplicitRejoinStageReport> {
  await pair.second.page.getByLabel('房间码').fill(roomCode);
  await pair.second.page.getByRole('button', { name: '加入房间' }).click();
  await expectConnectedParticipants(pair, policy, creatorName, joinerName);

  const [creatorConnected, joinerConnected] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === departure.creatorWaiting.id &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks === 1 &&
        matchesIcePolicy(peer, policy),
    ),
    waitForPeer(
      pair.second.page,
      (peer, snapshot) =>
        peer.id !== departure.joinerBeforeLeave.id &&
        peer.connectionState === 'connected' &&
        peer.liveRemoteAudioTracks === 1 &&
        matchesIcePolicy(peer, policy) &&
        snapshot.peers.some(
          (candidate) =>
            candidate.id === departure.joinerBeforeLeave.id && candidate.closed,
        ),
    ),
  ]);

  await proveBidirectionalAudio(pair);
  const [creatorRejoined, joinerRejoined] = await Promise.all([
    waitForPeer(
      pair.first.page,
      (peer) =>
        peer.id === creatorConnected.id &&
        peer.packetsSentAudio > creatorConnected.packetsSentAudio &&
        peer.packetsReceivedAudio > creatorConnected.packetsReceivedAudio &&
        peer.bytesSentAudio > creatorConnected.bytesSentAudio &&
        peer.bytesReceivedAudio > creatorConnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0,
    ),
    waitForPeer(
      pair.second.page,
      (peer) =>
        peer.id === joinerConnected.id &&
        peer.packetsSentAudio > joinerConnected.packetsSentAudio &&
        peer.packetsReceivedAudio > joinerConnected.packetsReceivedAudio &&
        peer.bytesSentAudio > joinerConnected.bytesSentAudio &&
        peer.bytesReceivedAudio > joinerConnected.bytesReceivedAudio &&
        peer.inboundAudioEnergy > 0,
    ),
  ]);

  await expectConnectedParticipants(pair, policy, creatorName, joinerName);
  return {
    ...departure,
    creatorRejoined,
    joinerRejoined,
  };
}

async function proveExplicitLeaveAndRejoin(
  pair: AcceptancePair,
  policy: AcceptancePolicy,
  roomCode: string,
  run: string,
): Promise<ExplicitLeaveRejoinReport> {
  const creatorName = `Alice-${policy}`;
  const sameUserName = `Bob-${policy}`;
  const newUserName = `Charlie-${policy}`;

  const sameUserDeparture = await leaveJoinerExplicitly(pair, sameUserName);
  const sameUser = await joinExistingRoomAndProveAudio(
    pair,
    policy,
    roomCode,
    creatorName,
    sameUserName,
    sameUserDeparture,
  );

  const newUserDeparture = await leaveJoinerExplicitly(pair, sameUserName);
  await pair.second.page.getByRole('button', { name: '退出登录' }).click();
  await expect(
    pair.second.page.getByRole('heading', { name: '登录 WO' }),
  ).toBeVisible();
  await registerThenLogin(
    pair.second.page,
    newUserName,
    `charlie-${policy}-${run}@e2e.invalid`,
  );
  const newUser = await joinExistingRoomAndProveAudio(
    pair,
    policy,
    roomCode,
    creatorName,
    newUserName,
    newUserDeparture,
  );
  await expect(
    pair.first.page.getByTitle(sameUserName, { exact: true }),
  ).toHaveCount(0);

  return {
    roomCodeLength: roomCode.length,
    sameRoomCodeReused: true,
    sameUser,
    newUser,
  };
}

function v13SoakDurationMs(): number {
  const configured = process.env['WO_V13_SOAK_MS'];
  if (configured === undefined) return v13MinimumSoakDurationMs;
  if (!/^\d+$/u.test(configured)) {
    throw new Error('WO_V13_SOAK_MS must be an integer number of milliseconds');
  }
  const duration = Number(configured);
  if (
    !Number.isSafeInteger(duration) ||
    duration < v13MinimumSoakDurationMs ||
    duration > v13MaximumSoakDurationMs
  ) {
    throw new Error('WO_V13_SOAK_MS must be between 600000 and 1800000');
  }
  return duration;
}

async function waitForV13StableResources(
  page: Page,
  expectedPeerConnections: number,
  expectedSignalingSockets: number,
): Promise<AcceptanceSnapshot> {
  let latest: AcceptanceSnapshot | null = null;
  await expect
    .poll(
      async () => {
        latest = await requiredDiagnostics(page);
        return {
          activePeerConnections: latest.resources.activePeerConnections,
          openSignalingSockets: latest.resources.openSignalingSockets,
          liveMicrophoneTracks: latest.resources.liveMicrophoneTracks,
          liveSystemAudioTracks: latest.resources.liveSystemAudioTracks,
          activeRnnoiseAudioContexts:
            latest.resources.activeRnnoiseAudioContexts,
          peerConnections: latest.peers.length,
          signalingSockets: latest.sockets.length,
          transitionalSockets: latest.sockets.filter(
            (socket) => socket.state !== 1 && socket.state !== 3,
          ).length,
        };
      },
      { timeout: 60_000 },
    )
    .toEqual({
      activePeerConnections: 1,
      openSignalingSockets: 1,
      liveMicrophoneTracks: 1,
      liveSystemAudioTracks: 0,
      activeRnnoiseAudioContexts: 1,
      peerConnections: expectedPeerConnections,
      signalingSockets: expectedSignalingSockets,
      transitionalSockets: 0,
    });
  if (latest === null) throw new Error('V13 resource snapshot is unavailable');
  expect(latest.peers.filter((peer) => !peer.closed)).toHaveLength(1);
  expect(latest.sockets.filter((socket) => socket.state === 1)).toHaveLength(1);
  expect(latest.rnnoiseActive).toBe(true);
  return latest;
}

function expectV13MemoryBounded(
  current: AppMemorySample,
  baseline: AppMemorySample,
): void {
  expect(current.processes.length).toBeLessThanOrEqual(
    baseline.processes.length + v13ProcessGrowthBudget,
  );
  expect(current.totalWorkingSetSizeKiB).toBeLessThanOrEqual(
    baseline.totalWorkingSetSizeKiB + v13MemoryGrowthBudgetKiB,
  );
}

async function collectV13Checkpoint(
  pair: AcceptancePair,
  input: {
    readonly action: string;
    readonly cycle: number;
    readonly expectedFirstPeers: number;
    readonly expectedSecondPeers: number;
    readonly expectedFirstSockets: number;
    readonly expectedSecondSockets: number;
    readonly startedAt: number;
  },
): Promise<{
  readonly action: string;
  readonly cycle: number;
  readonly elapsedMs: number;
  readonly first: Readonly<{
    snapshot: AcceptanceSnapshot;
    memory: AppMemorySample;
  }>;
  readonly second: Readonly<{
    snapshot: AcceptanceSnapshot;
    memory: AppMemorySample;
  }>;
}> {
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    waitForV13StableResources(
      pair.first.page,
      input.expectedFirstPeers,
      input.expectedFirstSockets,
    ),
    waitForV13StableResources(
      pair.second.page,
      input.expectedSecondPeers,
      input.expectedSecondSockets,
    ),
  ]);
  const [firstMemory, secondMemory] = await Promise.all([
    memorySample(pair.first.application),
    memorySample(pair.second.application),
  ]);
  return {
    action: input.action,
    cycle: input.cycle,
    elapsedMs: Date.now() - input.startedAt,
    first: { snapshot: firstSnapshot, memory: firstMemory },
    second: { snapshot: secondSnapshot, memory: secondMemory },
  };
}

async function attachV13Json(name: string, value: unknown): Promise<void> {
  const outputPath = test.info().outputPath(name);
  await writeFile(outputPath, JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await test.info().attach(name, {
    path: outputPath,
    contentType: 'application/json',
  });
}

test('V13 ten-minute call and repeated recovery keep resources bounded', async ({
  acceptance,
}) => {
  test.skip(
    process.env['WO_RUN_V13_SOAK'] !== '1',
    'Set WO_RUN_V13_SOAK=1 to run the 10-30 minute resource soak',
  );
  const soakDurationMs = v13SoakDurationMs();
  test.setTimeout(soakDurationMs + 5 * 60_000);
  const pair = await acceptance.launch('relay');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);
  const roomCode = await pair.first.page
    .locator('.room-header code')
    .innerText();
  const startedAt = Date.now();

  const initialFirst = await requiredDiagnostics(pair.first.page);
  const initialSecond = await requiredDiagnostics(pair.second.page);
  let expectedFirstPeers = initialFirst.peers.length;
  let expectedSecondPeers = initialSecond.peers.length;
  let expectedFirstSockets = initialFirst.sockets.length;
  let expectedSecondSockets = initialSecond.sockets.length;
  const checkpoints = [
    await collectV13Checkpoint(pair, {
      action: 'baseline',
      cycle: 0,
      expectedFirstPeers,
      expectedSecondPeers,
      expectedFirstSockets,
      expectedSecondSockets,
      startedAt,
    }),
  ];
  const baseline = checkpoints[0];
  if (baseline === undefined) {
    throw new Error('V13 baseline checkpoint is unavailable');
  }
  await attachV13Json('v13-cycle-00-baseline.json', baseline);

  let cycle = 0;
  let signalingRecoveries = 0;
  let transportRebuilds = 0;
  while (Date.now() - startedAt < soakDurationMs) {
    const scheduledAt = startedAt + (cycle + 1) * v13RecoveryIntervalMs;
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) await pair.first.page.waitForTimeout(waitMs);
    cycle += 1;

    let action: string;
    if (cycle % 2 === 1) {
      const [firstBefore, secondBefore] = await Promise.all([
        waitForPeer(
          pair.first.page,
          (peer) => peer.connectionState === 'connected',
        ),
        waitForPeer(
          pair.second.page,
          (peer) => peer.connectionState === 'connected',
        ),
      ]);
      const dropFirst = signalingRecoveries % 2 === 0;
      expect(
        await dropSignaling(dropFirst ? pair.first.page : pair.second.page),
      ).toBe(1);
      if (dropFirst) expectedFirstSockets += 1;
      else expectedSecondSockets += 1;
      signalingRecoveries += 1;
      action = dropFirst ? 'drop-first-wss' : 'drop-second-wss';
      await expectConnectedParticipants(
        pair,
        'relay',
        'Alice-relay',
        'Bob-relay',
      );
      await waitForSameTransportAudioRecovery(
        pair,
        'relay',
        firstBefore,
        secondBefore,
      );
    } else {
      const departure = await leaveJoinerExplicitly(pair, 'Bob-relay');
      await joinExistingRoomAndProveAudio(
        pair,
        'relay',
        roomCode,
        'Alice-relay',
        'Bob-relay',
        departure,
      );
      expectedFirstPeers += 1;
      expectedSecondPeers += 1;
      expectedSecondSockets += 1;
      transportRebuilds += 1;
      action = 'explicit-leave-rejoin';
    }

    const checkpoint = await collectV13Checkpoint(pair, {
      action,
      cycle,
      expectedFirstPeers,
      expectedSecondPeers,
      expectedFirstSockets,
      expectedSecondSockets,
      startedAt,
    });
    expectV13MemoryBounded(checkpoint.first.memory, baseline.first.memory);
    expectV13MemoryBounded(checkpoint.second.memory, baseline.second.memory);
    checkpoints.push(checkpoint);
    await attachV13Json(
      `v13-cycle-${String(cycle).padStart(2, '0')}-${action}.json`,
      checkpoint,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  expect(elapsedMs).toBeGreaterThanOrEqual(soakDurationMs);
  expect(signalingRecoveries).toBeGreaterThanOrEqual(5);
  expect(transportRebuilds).toBeGreaterThanOrEqual(5);
  await attachV13Json('v13-resource-soak-summary.json', {
    soakDurationMs,
    elapsedMs,
    cycles: cycle,
    signalingRecoveries,
    transportRebuilds,
    memoryGrowthBudgetKiB: v13MemoryGrowthBudgetKiB,
    processGrowthBudget: v13ProcessGrowthBudget,
    checkpoints,
  });
});

for (const policy of ['all', 'relay'] as const) {
  test(`V09 WSS short/long recovery ${policy === 'all' ? 'direct' : 'forced relay'} path`, async ({
    acceptance,
  }) => {
    const pair = await acceptance.launch(policy);
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await registerPair(pair, policy, run);
    await connectRoom(pair, false);
    await proveBidirectionalAudio(pair);

    const report = await proveV09SignalingRecovery(pair, policy);
    await test.info().attach(`v09-signaling-recovery-${policy}.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  });
}

test('V10 ICE disconnected/restart forced relay path', async ({
  acceptance,
}) => {
  const pair = await acceptance.launch('relay');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);

  const report = await proveRelayIceRestart(pair);
  await test.info().attach('v10-ice-restart-relay.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});

test('V10 ICE failed/authoritative reset forced relay path', async ({
  acceptance,
}) => {
  const pair = await acceptance.launch('relay');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);

  const report = await proveRelayIceFailureReset(pair);
  await test.info().attach('v10-ice-reset-relay.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');
});

test('S12 active screen and system audio survive rejoin, WSS drop, and ICE reset', async ({
  acceptance,
}) => {
  test.setTimeout(6 * 60_000);
  const pair = await acceptance.launch('relay');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);
  const roomCodeLocator = pair.first.page.locator('.room-header code');
  await expect(roomCodeLocator).toHaveText(/^\d{6}$/u);
  const roomCode = await roomCodeLocator.innerText();

  await startMotionShare(pair.first.page, pair.motionTitle, true);
  const baseline = await waitForActiveScreenAndSystemAudio(pair, {
    transport: 'initial',
    previous: null,
    expectedCaptureAttempts: 1,
  });

  const departure = await leaveJoinerExplicitly(pair, 'Bob-relay');
  await expect(pair.first.page.getByLabel('屏幕共享状态')).toBeVisible();
  let waitingSnapshot: AcceptanceSnapshot | null = null;
  await expect
    .poll(
      async () => {
        waitingSnapshot = await requiredDiagnostics(pair.first.page);
        return {
          activePeerConnections:
            waitingSnapshot.resources.activePeerConnections,
          captureAttempts: waitingSnapshot.capture.attempts,
          captureSuccesses: waitingSnapshot.capture.successes,
          liveMicrophoneTracks: waitingSnapshot.resources.liveMicrophoneTracks,
          liveSystemAudioTracks:
            waitingSnapshot.resources.liveSystemAudioTracks,
        };
      },
      { timeout: 45_000 },
    )
    .toEqual({
      activePeerConnections: 1,
      captureAttempts: 1,
      captureSuccesses: 1,
      liveMicrophoneTracks: 1,
      liveSystemAudioTracks: 1,
    });
  if (waitingSnapshot === null) {
    throw new Error('S12 waiting resource snapshot is unavailable');
  }

  await pair.second.page.getByLabel('房间码').fill(roomCode);
  await pair.second.page.getByRole('button', { name: '加入房间' }).click();
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');
  const afterRejoin = await waitForActiveScreenAndSystemAudio(pair, {
    transport: 'new',
    previous: baseline,
    expectedCaptureAttempts: 1,
  });
  expect(afterRejoin.first.id).toBe(departure.creatorWaiting.id);
  expect(afterRejoin.second.id).not.toBe(departure.joinerBeforeLeave.id);

  const firstBeforeDrop = await requiredDiagnostics(pair.first.page);
  expect(await dropSignaling(pair.first.page)).toBe(1);
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');
  await waitForSameTransportAudioRecovery(
    pair,
    'relay',
    afterRejoin.first,
    afterRejoin.second,
  );
  const afterWssDrop = await waitForActiveScreenAndSystemAudio(pair, {
    transport: 'same',
    previous: afterRejoin,
    expectedCaptureAttempts: 1,
  });
  const firstAfterDrop = await requiredDiagnostics(pair.first.page);
  expect(firstAfterDrop.signalingDrops).toBe(
    firstBeforeDrop.signalingDrops + 1,
  );

  const iceReset = await proveRelayIceFailureReset(pair);
  const afterIceReset = await waitForActiveScreenAndSystemAudio(pair, {
    transport: 'new',
    previous: afterWssDrop,
    expectedCaptureAttempts: 1,
  });
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');

  await test.info().attach('s12-active-share-recovery-relay.json', {
    body: JSON.stringify(
      {
        roomCodeLength: roomCode.length,
        sameRoomCodeReused: true,
        baseline,
        departure,
        waiting: {
          capture: waitingSnapshot.capture,
          resources: waitingSnapshot.resources,
        },
        afterRejoin,
        afterWssDrop,
        iceReset,
        afterIceReset,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('S13 lock and suspend release screen video, system audio, and lease', async ({
  acceptance,
}) => {
  test.setTimeout(4 * 60_000);
  const pair = await acceptance.launch('relay');
  const reversedPair: AcceptancePair = {
    first: pair.second,
    second: pair.first,
    motionTitle: pair.motionTitle,
    launchAdditional: () => pair.launchAdditional(),
    close: () => pair.close(),
  };
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);

  await startMotionShare(pair.first.page, pair.motionTitle, true);
  const aliceActive = await waitForLifecycleCaptureActive(pair, {
    previous: null,
    expectedCaptureAttempts: 1,
    expectedRemoteCaptureAttempts: 0,
  });
  await emitCaptureLifecycleEvent(pair.first.application, 'lock-screen');
  const afterLock = await waitForLifecycleShareStopped(pair, {
    previous: aliceActive,
    expectedCaptureAttempts: 1,
  });
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');

  await startMotionShare(pair.second.page, pair.motionTitle, true);
  const bobActive = await waitForLifecycleCaptureActive(reversedPair, {
    previous: {
      first: afterLock.second,
      second: afterLock.first,
    },
    expectedCaptureAttempts: 1,
    expectedRemoteCaptureAttempts: 1,
  });
  await emitCaptureLifecycleEvent(pair.second.application, 'suspend');
  const afterSuspend = await waitForLifecycleShareStopped(reversedPair, {
    previous: bobActive,
    expectedCaptureAttempts: 1,
  });
  await expectConnectedParticipants(pair, 'relay', 'Alice-relay', 'Bob-relay');

  await startMotionShare(pair.first.page, pair.motionTitle, true);
  const aliceReacquired = await waitForLifecycleCaptureActive(pair, {
    previous: {
      first: afterSuspend.second,
      second: afterSuspend.first,
    },
    expectedCaptureAttempts: 2,
    expectedRemoteCaptureAttempts: 1,
  });

  await test.info().attach('s13-capture-lifecycle-relay.json', {
    body: JSON.stringify(
      {
        aliceActive,
        afterLock,
        bobActive,
        afterSuspend,
        aliceReacquired,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  await pair.first.page.getByRole('button', { name: '停止共享' }).click();
  await expect(
    pair.second.page.locator('video[aria-label$="的共享屏幕"]'),
  ).toHaveCount(0, { timeout: 30_000 });
});

for (const mode of ['exit', 'crash'] as const) {
  const title =
    mode === 'exit'
      ? 'normal exit releases active capture and lease before TTL'
      : 'hard crash permits takeover within the lease TTL bound';
  test(`S13 ${title}`, async ({ acceptance }) => {
    test.setTimeout(4 * 60_000);
    const pair = await acceptance.launch('relay');
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await registerPair(pair, 'relay', run);
    await connectRoom(pair, false);
    await proveBidirectionalAudio(pair);

    await startMotionShare(pair.first.page, pair.motionTitle, true);
    const active = await waitForLifecycleCaptureActive(pair, {
      previous: null,
      expectedCaptureAttempts: 1,
      expectedRemoteCaptureAttempts: 0,
    });
    const report = await proveOwnerProcessRelease(pair, { mode, active });

    await test.info().attach(`s13-owner-${mode}-relay.json`, {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  });
}

test('S13 screen lease expires when maintenance stalls on a live connection', async ({
  acceptance,
}) => {
  test.setTimeout(4 * 60_000);
  const pair = await acceptance.launch('relay');
  const reversedPair: AcceptancePair = {
    first: pair.second,
    second: pair.first,
    motionTitle: pair.motionTitle,
    launchAdditional: () => pair.launchAdditional(),
    close: () => pair.close(),
  };
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'relay', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);

  await startMotionShare(pair.first.page, pair.motionTitle, true);
  const ownerActive = await waitForLifecycleCaptureActive(pair, {
    previous: null,
    expectedCaptureAttempts: 1,
    expectedRemoteCaptureAttempts: 0,
  });
  expect(await pauseScreenLeaseMaintenance(pair.first.page)).toBe(1);
  await expect
    .poll(
      async () => {
        const snapshot = await requiredDiagnostics(pair.first.page);
        return {
          paused: snapshot.screenLeaseMaintenancePaused,
          renewals: snapshot.blockedScreenLeaseRenewals,
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ paused: true, renewals: 2 });

  const busyButton = pair.second.page.getByRole('button', {
    name: 'Alice-relay正在共享',
  });
  await expect(busyButton).toBeVisible();
  await expect(busyButton).toBeDisabled();
  const beforeExpiry = await requiredDiagnostics(pair.first.page);
  expect(beforeExpiry.resources.openSignalingSockets).toBe(1);
  expect(beforeExpiry.signalingDrops).toBe(0);

  await expect(
    pair.second.page.getByRole('button', { name: '共享屏幕' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        (await requiredDiagnostics(pair.first.page)).blockedScreenLeaseReleases,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(1);
  const afterExpiry = await requiredDiagnostics(pair.first.page);
  expect(afterExpiry.resources.openSignalingSockets).toBe(1);
  expect(afterExpiry.signalingDrops).toBe(0);

  await startMotionShare(pair.second.page, pair.motionTitle, true);
  const survivorAcquired = await waitForLifecycleCaptureActive(reversedPair, {
    previous: {
      first: ownerActive.second,
      second: ownerActive.first,
    },
    expectedCaptureAttempts: 1,
    expectedRemoteCaptureAttempts: 1,
  });
  expect(await resumeScreenLeaseMaintenance(pair.first.page)).toBe(1);

  await test.info().attach('s13-screen-lease-ttl-relay.json', {
    body: JSON.stringify(
      {
        ownerActive,
        beforeExpiry,
        afterExpiry,
        survivorAcquired,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  await pair.second.page.getByRole('button', { name: '停止共享' }).click();
  await expect(
    pair.first.page.locator('video[aria-label$="的共享屏幕"]'),
  ).toHaveCount(0, { timeout: 30_000 });
});

test('V11 account takeover closes the superseded desktop without auto-resume', async ({
  acceptance,
}) => {
  const pair = await acceptance.launch('all');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const joinerEmail = `bob-all-${run}@e2e.invalid`;
  await registerPair(pair, 'all', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);
  const roomCode = pair.first.page.locator('.room-header code');
  await expect(roomCode).toHaveText(/^\d{6}$/u);
  const code = await roomCode.innerText();
  const creatorBefore = await waitForPeer(
    pair.first.page,
    (peer) => peer.connectionState === 'connected',
  );
  const supersededBefore = await requiredDiagnostics(pair.second.page);
  const supersededSocketBefore = supersededBefore.sockets.find(
    (socket) => socket.state === 1,
  );
  expect(supersededSocketBefore).toBeDefined();
  const supersededPeer = await waitForPeer(
    pair.second.page,
    (peer) => peer.connectionState === 'connected',
  );
  const replacement = await pair.launchAdditional();
  await loginExisting(replacement.page, joinerEmail);
  await replacement.page.getByLabel('房间码').fill(code);
  await replacement.page.getByRole('button', { name: '加入房间' }).click();

  await expect(
    pair.second.page.getByText('账号已在另一台设备接管，当前通话已结束'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    pair.second.page.getByRole('button', { name: '创建房间' }),
  ).toBeVisible();
  const closedPeer = await waitForClosedPeer(
    pair.second.page,
    supersededPeer.id,
  );
  await expect(replacement.page.locator('.room-header code')).toHaveText(code);

  const activePair: AcceptancePair = {
    first: pair.first,
    second: replacement,
    motionTitle: pair.motionTitle,
    launchAdditional: pair.launchAdditional,
    close: pair.close,
  };
  await expectConnectedParticipants(activePair, 'all', 'Alice-all', 'Bob-all');
  await proveBidirectionalAudio(activePair);
  const creatorAfter = await waitForPeer(
    pair.first.page,
    (peer) =>
      peer.id > creatorBefore.id && peer.connectionState === 'connected',
  );
  const replacementPeer = await waitForPeer(
    replacement.page,
    (peer) => peer.connectionState === 'connected',
  );
  const supersededAfter = await requiredDiagnostics(pair.second.page);
  expect(supersededAfter.sockets).toHaveLength(supersededBefore.sockets.length);
  expect(
    supersededAfter.sockets.filter((socket) => socket.state === 1),
  ).toHaveLength(0);
  const supersededSocketAfter = supersededAfter.sockets.find(
    (socket) => socket.id === supersededSocketBefore?.id,
  );
  expect(supersededSocketAfter).toMatchObject({
    closes: 1,
    lastCloseCode: 4409,
    lastCloseReason: 'SESSION_REPLACED',
  });

  await test.info().attach('v11-account-takeover.json', {
    body: JSON.stringify(
      {
        roomCodeLength: code.length,
        creatorBeforeId: creatorBefore.id,
        creatorAfterId: creatorAfter.id,
        supersededPeerId: supersededPeer.id,
        oldPeerClosed: closedPeer.closed,
        replacementPeerId: replacementPeer.id,
        socketsBefore: supersededBefore.sockets.length,
        socketsAfter: supersededAfter.sockets.length,
        openSocketsAfter: supersededAfter.sockets.filter(
          (socket) => socket.state === 1,
        ).length,
        supersededCloseCode: supersededSocketAfter?.lastCloseCode,
        supersededCloseReason: supersededSocketAfter?.lastCloseReason,
        freshBidirectionalAudio: true,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('V11 server restart closes lost rooms and permits a fresh call', async ({
  acceptance,
}) => {
  const pair = await acceptance.launch('all');
  const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await registerPair(pair, 'all', run);
  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);
  const firstBefore = await waitForPeer(
    pair.first.page,
    (peer) => peer.connectionState === 'connected',
  );
  const secondBefore = await waitForPeer(
    pair.second.page,
    (peer) => peer.connectionState === 'connected',
  );

  await restartIntegrationServer();

  const restartMessage = '服务已重启，原房间已关闭';
  await expect(pair.first.page.getByText(restartMessage)).toBeVisible({
    timeout: 45_000,
  });
  await expect(pair.second.page.getByText(restartMessage)).toBeVisible({
    timeout: 45_000,
  });
  const firstClosed = await waitForClosedPeer(pair.first.page, firstBefore.id);
  const secondClosed = await waitForClosedPeer(
    pair.second.page,
    secondBefore.id,
  );

  await connectRoom(pair, false);
  await proveBidirectionalAudio(pair);
  const firstAfter = await waitForPeer(
    pair.first.page,
    (peer) => peer.connectionState === 'connected' && peer.id > firstBefore.id,
  );
  const secondAfter = await waitForPeer(
    pair.second.page,
    (peer) => peer.connectionState === 'connected' && peer.id > secondBefore.id,
  );

  await test.info().attach('v11-server-restart.json', {
    body: JSON.stringify(
      {
        firstBeforeId: firstBefore.id,
        secondBeforeId: secondBefore.id,
        firstClosed: firstClosed.closed,
        secondClosed: secondClosed.closed,
        firstAfterId: firstAfter.id,
        secondAfterId: secondAfter.id,
        freshBidirectionalAudio: true,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

for (const policy of ['all', 'relay'] as const) {
  test(`V08 explicit leave/rejoin ${policy === 'all' ? 'direct' : 'forced relay'} path`, async ({
    acceptance,
  }) => {
    const pair = await acceptance.launch(policy);
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await registerPair(pair, policy, run);
    await connectRoom(pair, false);
    const roomCode = await pair.first.page
      .locator('.room-header code')
      .innerText();
    expect(roomCode).toMatch(/^\d{6}$/u);
    await proveBidirectionalAudio(pair);

    const explicitLeaveRejoinReport = await proveExplicitLeaveAndRejoin(
      pair,
      policy,
      roomCode,
      run,
    );
    await test.info().attach(`v08-explicit-rejoin-${policy}.json`, {
      body: JSON.stringify(explicitLeaveRejoinReport, null, 2),
      contentType: 'application/json',
    });

    await pair.second.close();
    await expect(pair.first.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    });
    await expect(pair.first.page.locator('[title="离线"]')).toBeVisible();
  });
}

for (const policy of ['all', 'relay'] as const) {
  test(`real two-peer ${policy === 'all' ? 'direct' : 'forced relay'} path`, async ({
    acceptance,
  }) => {
    const pair = await acceptance.launch(policy);
    await proveCameraRequestRejected(pair.first.page);
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await registerPair(pair, policy, run);
    await connectRoom(pair, policy === 'all');
    await proveBidirectionalAudio(pair);
    const noiseIntensitySwitchReport = await proveNoiseIntensitySwitching(pair);
    await test.info().attach(`v06-rnnoise-${policy}.json`, {
      body: JSON.stringify(noiseIntensitySwitchReport, null, 2),
      contentType: 'application/json',
    });
    if (policy === 'all') {
      await proveMicrophoneRevocationRecovery(pair);
    }

    const first = await waitForPeer(pair.first.page, () => true);
    const second = await waitForPeer(pair.second.page, () => true);
    expect(first.transceivers).toBe(3);
    expect(second.transceivers).toBe(3);
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

    const remoteAudioIsolation = await proveScreenAndBitrates(pair);
    await test.info().attach(`v07-remote-audio-isolation-${policy}.json`, {
      body: JSON.stringify(remoteAudioIsolation, null, 2),
      contentType: 'application/json',
    });
    await proveSignalingRecovery(pair);

    await pair.second.close();
    await expect(pair.first.page.getByText('正在重新连接')).toBeVisible({
      timeout: 30_000,
    });
    await expect(pair.first.page.locator('[title="离线"]')).toBeVisible();
  });
}
