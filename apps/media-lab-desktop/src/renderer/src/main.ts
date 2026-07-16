import {
  calculateRtcStats,
  type MediaStats,
  type RtcStatsRecord,
  type RtcStatsSample,
} from '@wo/media-policy';
import {
  createIcons,
  Download,
  MonitorUp,
  Play,
  RefreshCw,
  Square,
  Video,
} from 'lucide';
import { Device, type types as MediasoupTypes } from 'mediasoup-client';

import {
  applyProducerBitrateWithEvent,
  type BitrateChangeEvent,
} from './bitrate-controller.js';
import { DEFAULT_LAB_CODEC, type LabCodec } from './codec.js';
import { LabConnectionManager } from './connection.js';
import {
  consumeFirstProducer,
  createLabReceiveTransport,
  createLabSendTransport,
  produceScreen,
} from './media-flow.js';
import {
  closeMediaSessionResources,
  type MediaSessionResources,
} from './resource-cleanup.js';
import { SignalingClient, type SignalingSocket } from './signaling.js';
import { buildMediaLabStatsExport } from './stats-export.js';
import './styles.css';

type Role = 'publisher' | 'receiver';

const parameters = new URLSearchParams(location.search);
const role: Role =
  parameters.get('role') === 'receiver' ? 'receiver' : 'publisher';
const labUrl = parameters.get('labUrl') ?? 'wss://127.0.0.1:4443';

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
};

const video = element<HTMLVideoElement>('video');
const sourceSelect = element<HTMLSelectElement>('sourceSelect');
const codecSelect = element<HTMLSelectElement>('codecSelect');
const bitrateRange = element<HTMLInputElement>('bitrateRange');
const bitrateOutput = element<HTMLOutputElement>('bitrateOutput');
const startButton = element<HTMLButtonElement>('startButton');
const stopButton = element<HTMLButtonElement>('stopButton');
const statusText = element<HTMLSpanElement>('statusText');
const statusDot = element<HTMLSpanElement>('statusDot');

codecSelect.value = DEFAULT_LAB_CODEC;

let transport: MediasoupTypes.Transport | null = null;
let producer: MediasoupTypes.Producer | null = null;
let consumer: MediasoupTypes.Consumer | null = null;
let stream: MediaStream | null = null;
let statsTimer: number | null = null;
let previousStats: RtcStatsSample | undefined;
let lastAppliedBitrate = 4_000_000;
let sessionResources = createSessionResources();
let stopPromise: Promise<void> | null = null;
const samples: MediaStats[] = [];
const bitrateEvents: BitrateChangeEvent[] = [];

function createSessionResources(): MediaSessionResources {
  return { producers: [], consumers: [], transports: [] };
}

function setStatus(
  text: string,
  state: 'idle' | 'working' | 'ready' | 'error',
) {
  statusText.textContent = text;
  statusDot.dataset.state = state;
  element('lastEvent').textContent = text;
}

function setRunning(running: boolean) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  sourceSelect.disabled = running;
  codecSelect.disabled = running;
}

function toReports(report: RTCStatsReport): RtcStatsRecord[] {
  return [...report.values()].map((entry) => ({
    ...entry,
    id: entry.id,
    type: entry.type,
  }));
}

function displayMetric(id: string, value: string | number | null) {
  element(id).textContent = value === null ? '-' : String(value);
}

function renderStats(stats: MediaStats) {
  displayMetric(
    'metricBitrate',
    stats.bitrateBps === null
      ? null
      : `${(stats.bitrateBps / 1_000_000).toFixed(2)} Mbps`,
  );
  displayMetric('metricCodec', stats.codec);
  displayMetric('metricCodecImplementation', stats.codecImplementation);
  displayMetric('metricDirection', stats.direction);
  displayMetric('metricRid', stats.rid);
  displayMetric('metricFps', stats.fps);
  displayMetric('metricRtt', stats.rttMs === null ? null : `${stats.rttMs} ms`);
  displayMetric(
    'metricLoss',
    stats.lossPercent === null ? null : `${stats.lossPercent}%`,
  );
  displayMetric(
    'metricJitter',
    stats.jitterMs === null ? null : `${stats.jitterMs} ms`,
  );
  displayMetric('metricNack', stats.nackCount);
  displayMetric('metricPli', stats.pliCount);
  displayMetric('metricFreeze', stats.freezeCount);
  displayMetric('metricQuality', stats.qualityLimitationReason);
  displayMetric('framesEncoded', stats.framesEncoded);
  displayMetric('framesDecoded', stats.framesDecoded);
  element('videoResolution').textContent =
    stats.width && stats.height ? `${stats.width} x ${stats.height}` : '-';
  element('videoFps').textContent =
    stats.fps === null ? '- fps' : `${stats.fps} fps`;
  element('sampleCount').textContent = String(samples.length);
}

async function sampleStats() {
  const source = producer ?? consumer;
  if (!source) return;
  const report = await source.getStats();
  const capture =
    role === 'publisher' && stream
      ? (stream.getVideoTracks()[0]?.getSettings() ?? null)
      : null;
  const current: RtcStatsSample = {
    timestampMs: Date.now(),
    capture,
    reports: toReports(report),
  };
  const stats = calculateRtcStats(previousStats, current);
  previousStats = current;
  samples.push(stats);
  renderStats(stats);
}

function startStats() {
  if (statsTimer !== null) window.clearInterval(statsTimer);
  void sampleStats();
  statsTimer = window.setInterval(() => {
    void sampleStats().catch((error: unknown) =>
      setStatus(
        error instanceof Error ? error.message : String(error),
        'error',
      ),
    );
  }, 1_000);
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const next = new WebSocket(url);
    next.addEventListener('open', () => resolve(next), { once: true });
    next.addEventListener(
      'error',
      () => reject(new Error('WSS connection failed')),
      {
        once: true,
      },
    );
  });
}

const connectionManager = new LabConnectionManager({
  async createSignaling() {
    const nextSocket = await openWebSocket(labUrl);
    return new SignalingClient(nextSocket as unknown as SignalingSocket);
  },
  createDevice: () => Device.factory(),
  loadDevice: async (nextDevice, routerRtpCapabilities) => {
    await nextDevice.load({
      routerRtpCapabilities:
        routerRtpCapabilities as MediasoupTypes.RtpCapabilities,
    });
  },
});

async function connect(): Promise<void> {
  await connectionManager.connect();
}

function currentConnection() {
  const current = connectionManager.current;
  if (!current) throw new Error('Signaling connection is unavailable');
  return current;
}

async function startPublisher() {
  const { device, signaling } = currentConnection();
  if (!sourceSelect.value) throw new Error('Select a capture source');
  await window.mediaLab.selectSource(sourceSelect.value);
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1_920 },
      height: { ideal: 1_080 },
      frameRate: { ideal: 60, max: 60 },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Display capture returned no video track');
  video.srcObject = stream;
  video.muted = true;
  element('captureSettings').textContent = JSON.stringify(
    track.getSettings(),
    null,
    2,
  );
  element('videoEmpty').hidden = true;
  track.addEventListener('ended', () => void stop(), { once: true });

  transport = (await createLabSendTransport(
    device as never,
    signaling,
  )) as unknown as MediasoupTypes.Transport;
  sessionResources.transports.push(transport);
  producer = (await produceScreen(
    transport as never,
    track,
    device.sendRtpCapabilities.codecs
      ? { codecs: device.sendRtpCapabilities.codecs }
      : {},
    codecSelect.value as LabCodec,
    lastAppliedBitrate,
  )) as MediasoupTypes.Producer;
  sessionResources.producers.push(producer);
}

async function startReceiver() {
  const { device, signaling } = currentConnection();
  transport = (await createLabReceiveTransport(
    device as never,
    signaling,
  )) as unknown as MediasoupTypes.Transport;
  sessionResources.transports.push(transport);
  consumer = (await consumeFirstProducer(
    device as never,
    transport as never,
    signaling,
  )) as MediasoupTypes.Consumer;
  sessionResources.consumers.push(consumer);
  stream = new MediaStream([consumer.track]);
  video.srcObject = stream;
  video.muted = true;
  element('videoEmpty').hidden = true;
  element('captureSettings').textContent = JSON.stringify(
    consumer.track.getSettings(),
    null,
    2,
  );
}

async function start() {
  setRunning(true);
  setStatus('Connecting', 'working');
  try {
    await connect();
    if (role === 'publisher') await startPublisher();
    else await startReceiver();
    startStats();
    setStatus('Streaming', 'ready');
  } catch (error) {
    await stop();
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function performStop() {
  if (statsTimer !== null) window.clearInterval(statsTimer);
  statsTimer = null;
  previousStats = undefined;
  await closeMediaSessionResources(
    connectionManager.current?.signaling ?? null,
    sessionResources,
  );
  for (const track of stream?.getTracks() ?? []) track.stop();
  producer = null;
  consumer = null;
  transport = null;
  stream = null;
  sessionResources = createSessionResources();
  video.srcObject = null;
  element('videoEmpty').hidden = false;
  setRunning(false);
  setStatus('Idle', 'idle');
}

function stop(): Promise<void> {
  if (stopPromise) return stopPromise;
  const operation = performStop().finally(() => {
    if (stopPromise === operation) stopPromise = null;
  });
  stopPromise = operation;
  return operation;
}

async function refreshSources() {
  const sources = await window.mediaLab.listSources();
  const selected = sourceSelect.value;
  sourceSelect.replaceChildren(new Option('Select source', ''));
  for (const source of sources) {
    sourceSelect.add(new Option(source.name, source.id));
  }
  if (sources.some((source) => source.id === selected))
    sourceSelect.value = selected;
}

async function updateBitrate(megabits: number) {
  const previous = lastAppliedBitrate;
  const target = megabits * 1_000_000;
  bitrateRange.value = String(megabits);
  bitrateOutput.value = `${megabits} Mbps`;
  for (const preset of document.querySelectorAll<HTMLButtonElement>(
    '[data-bitrate]',
  )) {
    preset.classList.toggle(
      'selected',
      Number(preset.dataset.bitrate) === megabits,
    );
  }
  const activeProducer = producer;
  const event = await applyProducerBitrateWithEvent(
    activeProducer as never,
    target,
  );
  bitrateEvents.push(event);
  if (!activeProducer) {
    lastAppliedBitrate = event.clampedBitrateBps ?? previous;
    const configuredMegabits = lastAppliedBitrate / 1_000_000;
    bitrateRange.value = String(configuredMegabits);
    bitrateOutput.value = `${configuredMegabits} Mbps`;
    setStatus(`Bitrate target ${configuredMegabits} Mbps`, 'idle');
    return;
  }
  if (event.success && event.clampedBitrateBps !== null) {
    lastAppliedBitrate = event.clampedBitrateBps;
    const appliedMegabits = event.clampedBitrateBps / 1_000_000;
    bitrateRange.value = String(appliedMegabits);
    bitrateOutput.value = `${appliedMegabits} Mbps`;
    setStatus(`Bitrate ${appliedMegabits} Mbps`, 'ready');
  } else {
    bitrateRange.value = String(previous / 1_000_000);
    bitrateOutput.value = `${previous / 1_000_000} Mbps`;
    const error = event.error;
    setStatus(
      error ? `${error.code}: ${error.message}` : 'BITRATE_UPDATE_FAILED',
      'error',
    );
  }
}

element('roleLabel').textContent =
  role === 'publisher' ? 'Publisher' : 'Receiver';
document.body.dataset.role = role;
createIcons({
  icons: { Download, MonitorUp, Play, RefreshCw, Square, Video },
  attrs: { 'stroke-width': 1.8 },
});

element<HTMLButtonElement>('refreshSources').addEventListener('click', () => {
  void refreshSources().catch((error: unknown) =>
    setStatus(error instanceof Error ? error.message : String(error), 'error'),
  );
});
sourceSelect.addEventListener('change', () => {
  if (sourceSelect.value) {
    void window.mediaLab.selectSource(sourceSelect.value);
  }
});
startButton.addEventListener('click', () => void start());
stopButton.addEventListener('click', () => void stop());
bitrateRange.addEventListener(
  'change',
  () => void updateBitrate(Number(bitrateRange.value)),
);
element('bitratePresets').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    '[data-bitrate]',
  );
  if (button?.dataset.bitrate)
    void updateBitrate(Number(button.dataset.bitrate));
});
element<HTMLButtonElement>('exportButton').addEventListener('click', () => {
  const exported = buildMediaLabStatsExport({
    role,
    labUrl,
    exportedAt: new Date().toISOString(),
    samples,
    events: bitrateEvents,
  });
  void window.mediaLab.exportStats(JSON.stringify(exported, null, 2));
});

if (role === 'publisher') {
  void refreshSources().catch((error: unknown) =>
    setStatus(error instanceof Error ? error.message : String(error), 'error'),
  );
}
