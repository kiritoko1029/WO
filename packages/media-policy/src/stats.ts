export interface CaptureSettings {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

export interface RtcStatsRecord {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RtcStatsSample {
  readonly timestampMs: number;
  readonly capture: CaptureSettings | null;
  readonly reports: readonly RtcStatsRecord[];
}

export interface MediaStats {
  readonly timestampMs: number;
  readonly direction: 'outbound' | 'inbound' | null;
  readonly rid: string | null;
  readonly capture: CaptureSettings | null;
  readonly codec: string | null;
  readonly codecImplementation: string | null;
  readonly bitrateBps: number | null;
  readonly framesEncoded: number | null;
  readonly framesDecoded: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly rttMs: number | null;
  readonly lossPercent: number | null;
  readonly jitterMs: number | null;
  readonly nackCount: number | null;
  readonly pliCount: number | null;
  readonly freezeCount: number | null;
  readonly qualityLimitationReason: string | null;
}

export type StatsSample = MediaStats;

function numberValue(
  record: RtcStatsRecord | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(
  record: RtcStatsRecord | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function chooseHighestResolution(
  reports: readonly RtcStatsRecord[],
): RtcStatsRecord | undefined {
  return [...reports].sort((left, right) => {
    const leftArea =
      (numberValue(left, 'frameWidth') ?? 0) *
      (numberValue(left, 'frameHeight') ?? 0);
    const rightArea =
      (numberValue(right, 'frameWidth') ?? 0) *
      (numberValue(right, 'frameHeight') ?? 0);
    if (leftArea !== rightArea) return rightArea - leftArea;

    const leftFrames =
      numberValue(left, 'framesDecoded') ??
      numberValue(left, 'framesEncoded') ??
      0;
    const rightFrames =
      numberValue(right, 'framesDecoded') ??
      numberValue(right, 'framesEncoded') ??
      0;
    if (leftFrames !== rightFrames) return rightFrames - leftFrames;
    return left.id.localeCompare(right.id);
  })[0];
}

function selectVideoRtp(
  reports: readonly RtcStatsRecord[],
): RtcStatsRecord | undefined {
  const outbound = reports.filter(
    (report) => report.type === 'outbound-rtp' && report.kind === 'video',
  );
  if (outbound.length > 0) {
    const fullLayer = outbound.filter((report) => report.rid === 'f');
    if (fullLayer.length > 0) return chooseHighestResolution(fullLayer);
    return outbound.length === 1 ? outbound[0] : undefined;
  }

  const inbound = reports.filter(
    (report) => report.type === 'inbound-rtp' && report.kind === 'video',
  );
  const fullLayer = inbound.filter((report) => report.rid === 'f');
  return chooseHighestResolution(fullLayer.length > 0 ? fullLayer : inbound);
}

function selectRemoteInbound(
  reports: readonly RtcStatsRecord[],
  rtp: RtcStatsRecord | undefined,
): RtcStatsRecord | undefined {
  if (!rtp) return undefined;
  const candidates = reports.filter(
    (report) => report.type === 'remote-inbound-rtp' && report.kind === 'video',
  );
  const matchingLocalId = candidates.filter(
    (report) => report.localId === rtp.id,
  );
  if (matchingLocalId.length === 1) return matchingLocalId[0];

  const rid = stringValue(rtp, 'rid');
  const matchingRid = rid
    ? candidates.filter((report) => report.rid === rid)
    : [];
  if (matchingRid.length === 1) return matchingRid[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findPreviousReport(
  previous: RtcStatsSample | undefined,
  current: RtcStatsRecord | undefined,
): RtcStatsRecord | undefined {
  if (!previous || !current) return undefined;
  return previous.reports.find((report) => report.id === current.id);
}

function calculateRate(
  previousValue: number | null,
  currentValue: number | null,
  elapsedMs: number,
  multiplier = 1,
): number | null {
  if (
    elapsedMs <= 0 ||
    previousValue === null ||
    currentValue === null ||
    currentValue < previousValue
  ) {
    return null;
  }
  return round(
    ((currentValue - previousValue) * multiplier * 1_000) / elapsedMs,
  );
}

function calculateLoss(
  previous: RtcStatsRecord | undefined,
  current: RtcStatsRecord | undefined,
): number | null {
  const previousLost = numberValue(previous, 'packetsLost');
  const currentLost = numberValue(current, 'packetsLost');
  const previousReceived = numberValue(previous, 'packetsReceived');
  const currentReceived = numberValue(current, 'packetsReceived');
  if (
    previousLost === null ||
    currentLost === null ||
    previousReceived === null ||
    currentReceived === null ||
    currentLost < previousLost ||
    currentReceived < previousReceived
  ) {
    return null;
  }
  const lostDelta = currentLost - previousLost;
  const receivedDelta = currentReceived - previousReceived;
  const totalDelta = lostDelta + receivedDelta;
  return totalDelta === 0 ? 0 : round((lostDelta / totalDelta) * 100);
}

export function calculateRtcStats(
  previous: RtcStatsSample | undefined,
  current: RtcStatsSample,
): MediaStats {
  const rtp = selectVideoRtp(current.reports);
  const previousRtp = findPreviousReport(previous, rtp);
  const direction =
    rtp?.type === 'outbound-rtp'
      ? 'outbound'
      : rtp?.type === 'inbound-rtp'
        ? 'inbound'
        : null;
  const byteKey = direction === 'outbound' ? 'bytesSent' : 'bytesReceived';
  const frameKey = direction === 'outbound' ? 'framesEncoded' : 'framesDecoded';
  const elapsedMs = previous ? current.timestampMs - previous.timestampMs : 0;

  const remoteInbound = selectRemoteInbound(current.reports, rtp);
  const previousRemoteInbound = findPreviousReport(previous, remoteInbound);
  const lossReport = direction === 'outbound' ? remoteInbound : rtp;
  const previousLossReport =
    direction === 'outbound' ? previousRemoteInbound : previousRtp;
  const candidatePair = current.reports.find(
    (report) =>
      report.type === 'candidate-pair' &&
      report.state === 'succeeded' &&
      report.nominated === true,
  );
  const codecId = stringValue(rtp, 'codecId');
  const codec = codecId
    ? stringValue(
        current.reports.find((report) => report.id === codecId),
        'mimeType',
      )
    : null;
  const codecImplementation =
    direction === 'outbound'
      ? stringValue(rtp, 'encoderImplementation')
      : direction === 'inbound'
        ? stringValue(rtp, 'decoderImplementation')
        : null;
  const rttSeconds =
    numberValue(remoteInbound, 'roundTripTime') ??
    numberValue(candidatePair, 'currentRoundTripTime');
  const jitterSeconds =
    numberValue(lossReport, 'jitter') ?? numberValue(remoteInbound, 'jitter');

  return {
    timestampMs: current.timestampMs,
    direction,
    rid: stringValue(rtp, 'rid'),
    capture: current.capture,
    codec,
    codecImplementation,
    bitrateBps: rtp
      ? calculateRate(
          numberValue(previousRtp, byteKey),
          numberValue(rtp, byteKey),
          elapsedMs,
          8,
        )
      : null,
    framesEncoded: numberValue(rtp, 'framesEncoded'),
    framesDecoded: numberValue(rtp, 'framesDecoded'),
    width: numberValue(rtp, 'frameWidth'),
    height: numberValue(rtp, 'frameHeight'),
    fps: rtp
      ? calculateRate(
          numberValue(previousRtp, frameKey),
          numberValue(rtp, frameKey),
          elapsedMs,
        )
      : null,
    rttMs: rttSeconds === null ? null : round(rttSeconds * 1_000),
    lossPercent: calculateLoss(previousLossReport, lossReport),
    jitterMs: jitterSeconds === null ? null : round(jitterSeconds * 1_000),
    nackCount: numberValue(rtp, 'nackCount'),
    pliCount: numberValue(rtp, 'pliCount'),
    freezeCount: numberValue(rtp, 'freezeCount'),
    qualityLimitationReason: stringValue(rtp, 'qualityLimitationReason'),
  };
}
