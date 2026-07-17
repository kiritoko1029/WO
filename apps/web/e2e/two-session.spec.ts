import { expect, test, type BrowserContext, type Page } from '@playwright/test';

interface AudioPeerSnapshot {
  readonly connectionState: RTCPeerConnectionState;
  readonly liveRemoteAudioTracks: number;
  readonly packetsSent: number;
  readonly packetsReceived: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly inboundAudioEnergy: number;
}

async function installPeerInstrumentation(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    const audioContexts: AudioContext[] = [];
    Object.defineProperties(window, {
      __woE2ePeers: { value: peers },
      __woE2eAudioContexts: { value: audioContexts },
    });

    const NativePeerConnection = window.RTCPeerConnection;
    class TrackedPeerConnection extends NativePeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
    }
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: TrackedPeerConnection,
      writable: true,
    });

    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints?: MediaStreamConstraints) => {
        if (constraints?.audio && !constraints.video) {
          const audioContext = new AudioContext({ sampleRate: 48_000 });
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          const destination = audioContext.createMediaStreamDestination();
          oscillator.frequency.value = 440;
          gain.gain.value = 0.2;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await audioContext.resume();
          audioContexts.push(audioContext);
          return destination.stream;
        }
        throw new DOMException(
          'Unsupported test capture request',
          'NotFoundError',
        );
      },
      writable: true,
    });
  });
}

async function register(
  page: Page,
  displayName: string,
  email: string,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: '注册账号' }).click();
  await page.getByLabel('显示名称').fill(displayName);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill('Wo-Web-E2E-Password-2026');
  await page.getByRole('button', { name: '创建账号' }).click();
  await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
}

async function audioSnapshot(page: Page): Promise<AudioPeerSnapshot | null> {
  return page.evaluate(async () => {
    const peers = (
      window as typeof window & {
        readonly __woE2ePeers?: readonly RTCPeerConnection[];
      }
    ).__woE2ePeers;
    const peer = peers
      ?.filter((candidate) => candidate.connectionState !== 'closed')
      .at(-1);
    if (peer === undefined) return null;

    let packetsSent = 0;
    let packetsReceived = 0;
    let bytesSent = 0;
    let bytesReceived = 0;
    let inboundAudioEnergy = 0;
    const stats = await peer.getStats();
    for (const value of stats.values()) {
      const report = value as RTCStats & {
        readonly kind?: string;
        readonly mediaType?: string;
        readonly packetsSent?: number;
        readonly packetsReceived?: number;
        readonly bytesSent?: number;
        readonly bytesReceived?: number;
        readonly totalAudioEnergy?: number;
      };
      const audio = report.kind === 'audio' || report.mediaType === 'audio';
      if (!audio) continue;
      if (report.type === 'outbound-rtp') {
        packetsSent += report.packetsSent ?? 0;
        bytesSent += report.bytesSent ?? 0;
      } else if (report.type === 'inbound-rtp') {
        packetsReceived += report.packetsReceived ?? 0;
        bytesReceived += report.bytesReceived ?? 0;
        inboundAudioEnergy += report.totalAudioEnergy ?? 0;
      }
    }
    return {
      connectionState: peer.connectionState,
      liveRemoteAudioTracks: peer
        .getReceivers()
        .filter(
          (receiver) =>
            receiver.track?.kind === 'audio' &&
            receiver.track.readyState === 'live',
        ).length,
      packetsSent,
      packetsReceived,
      bytesSent,
      bytesReceived,
      inboundAudioEnergy,
    };
  });
}

async function proveAudio(page: Page): Promise<AudioPeerSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await audioSnapshot(page);
        return (
          snapshot !== null &&
          snapshot.connectionState === 'connected' &&
          snapshot.liveRemoteAudioTracks === 1 &&
          snapshot.packetsSent > 5 &&
          snapshot.packetsReceived > 5 &&
          snapshot.bytesSent > 0 &&
          snapshot.bytesReceived > 0 &&
          snapshot.inboundAudioEnergy > 0
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const snapshot = await audioSnapshot(page);
  if (snapshot === null) throw new Error('WebRTC peer disappeared');
  return snapshot;
}

test('two isolated Web sessions create, join, and exchange audio', async ({
  browser,
}) => {
  const firstContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  const secondContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['microphone'],
  });
  try {
    await Promise.all([
      installPeerInstrumentation(firstContext),
      installPeerInstrumentation(secondContext),
    ]);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const run = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await Promise.all([
      register(first, 'Web Alice', `web-alice-${run}@e2e.invalid`),
      register(second, 'Web Bob', `web-bob-${run}@e2e.invalid`),
    ]);

    await first.getByRole('button', { name: '创建房间' }).click();
    const roomCode = first.locator('.room-header code');
    await expect(roomCode).toHaveText(/^\d{6}$/u);
    await second.getByLabel('房间码').fill(await roomCode.innerText());
    await second.getByRole('button', { name: '加入房间' }).click();
    await expect(first.getByText(/语音已连接/u)).toBeVisible();
    await expect(second.getByText(/语音已连接/u)).toBeVisible();

    const [firstStart, secondStart] = await Promise.all([
      proveAudio(first),
      proveAudio(second),
    ]);
    await expect
      .poll(async () => {
        const [firstNext, secondNext] = await Promise.all([
          audioSnapshot(first),
          audioSnapshot(second),
        ]);
        return (
          firstNext !== null &&
          secondNext !== null &&
          firstNext.packetsReceived > firstStart.packetsReceived &&
          firstNext.bytesReceived > firstStart.bytesReceived &&
          secondNext.packetsReceived > secondStart.packetsReceived &&
          secondNext.bytesReceived > secondStart.bytesReceived
        );
      })
      .toBe(true);
  } finally {
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
});
