export const FORMAL_DURATION_MS = 600_000;
export const MIN_COVERAGE_RATIO = 0.95;
export const MIN_FPS = 55;
export const MAX_SAMPLE_GAP_MS = 2_000;
export const MAX_WINDOW_MS = 2_500;
export const TARGET_WIDTH = 1_920;
export const TARGET_HEIGHT = 1_080;
export const BITRATE_TARGETS = Object.freeze(['auto', 5, 10, 20]);

const SECRET_PATTERN =
  /(?:\b(?:access|refresh)?[_-]?token\b|\bpassword\b|\bcredential\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu;
const SENSITIVE_KEY_PATTERN =
  /(?:^|_)(?:accessToken|refreshToken|token|password|credential|email|roomCode|sourceName|sourceTitle|windowTitle|ip|address)(?:$|_)/iu;

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function ratio(numerator, denominator) {
  return denominator <= 0 ? 0 : round(numerator / denominator);
}

function inspectTimeline(samples, durationMs) {
  const reasons = [];
  let maximumGapMs = 0;
  let previous = null;
  for (const [index, sample] of samples.entries()) {
    if (!finite(sample?.timestampMs)) {
      reasons.push({ code: 'INVALID_TIMESTAMP', index });
      continue;
    }
    if (previous !== null) {
      const gap = sample.timestampMs - previous;
      if (gap <= 0) reasons.push({ code: 'NON_MONOTONIC_TIMESTAMP', index });
      maximumGapMs = Math.max(maximumGapMs, gap);
    }
    previous = sample.timestampMs;
  }
  const expectedSamples = Math.floor(durationMs / 1_000) + 1;
  const coverageRatio = ratio(samples.length, expectedSamples);
  return {
    expectedSamples,
    actualSamples: samples.length,
    coverageRatio,
    maximumGapMs,
    reasons,
    pass:
      reasons.length === 0 &&
      coverageRatio >= MIN_COVERAGE_RATIO &&
      maximumGapMs <= MAX_SAMPLE_GAP_MS,
  };
}

function rollingCounter(samples, readCounter) {
  const windows = [];
  const reasons = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedMs = current.timestampMs - previous.timestampMs;
    const previousValue = readCounter(previous);
    const currentValue = readCounter(current);
    if (!finite(previousValue) || !finite(currentValue)) continue;
    if (currentValue < previousValue) {
      reasons.push({ code: 'COUNTER_RESET', index });
      continue;
    }
    if (elapsedMs <= 0 || elapsedMs > MAX_WINDOW_MS) continue;
    windows.push({
      index,
      timestampMs: current.timestampMs,
      elapsedMs,
      rate: ((currentValue - previousValue) * 1_000) / elapsedMs,
    });
  }
  const possibleWindows = Math.max(0, samples.length - 1);
  const validCoverageRatio = ratio(windows.length, possibleWindows);
  const passingRatio = ratio(
    windows.filter(({ rate }) => rate >= MIN_FPS).length,
    windows.length,
  );
  return {
    windows,
    reasons,
    validCoverageRatio,
    passingRatio,
    minimumRate:
      windows.length === 0
        ? null
        : round(Math.min(...windows.map(({ rate }) => rate))),
    pass:
      reasons.length === 0 &&
      validCoverageRatio >= MIN_COVERAGE_RATIO &&
      passingRatio >= MIN_COVERAGE_RATIO,
  };
}

function allDimensions(samples, readDimensions) {
  const invalid = [];
  for (const [index, sample] of samples.entries()) {
    const value = readDimensions(sample);
    if (value?.width !== TARGET_WIDTH || value?.height !== TARGET_HEIGHT) {
      invalid.push(index);
    }
  }
  return { invalid, pass: samples.length > 0 && invalid.length === 0 };
}

function stableTransport(samples) {
  const first = samples[0];
  const invalid = samples
    .map((sample, index) => ({ sample, index }))
    .filter(
      ({ sample }) =>
        sample.peerConnectionId !== first?.peerConnectionId ||
        sample.transceiverCount !== first?.transceiverCount ||
        sample.screenMid !== first?.screenMid ||
        sample.negotiationCount !== first?.negotiationCount,
    )
    .map(({ index }) => index);
  return {
    peerConnectionId: first?.peerConnectionId ?? null,
    transceiverCount: first?.transceiverCount ?? null,
    screenMid: first?.screenMid ?? null,
    negotiationCount: first?.negotiationCount ?? null,
    invalid,
    pass:
      samples.length > 0 &&
      typeof first?.peerConnectionId === 'string' &&
      first.peerConnectionId.length > 0 &&
      Number.isSafeInteger(first.transceiverCount) &&
      first.transceiverCount === 3 &&
      first.screenMid === '2' &&
      Number.isSafeInteger(first.negotiationCount) &&
      invalid.length === 0,
  };
}

function audioContinuity(samples) {
  const counters = [
    ['packetsReceived', (sample) => sample.audio?.packetsReceived],
    ['totalSamplesReceived', (sample) => sample.audio?.totalSamplesReceived],
    ['totalAudioEnergy', (sample) => sample.audio?.totalAudioEnergy],
  ];
  const failures = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const gapMs = current.timestampMs - previous.timestampMs;
    if (gapMs <= 0 || gapMs > MAX_SAMPLE_GAP_MS) {
      failures.push({ code: 'AUDIO_PROGRESS_GAP', index, gapMs });
      continue;
    }
    for (const [name, read] of counters) {
      const before = read(previous);
      const after = read(current);
      if (!finite(before) || !finite(after) || after <= before) {
        failures.push({ code: 'AUDIO_COUNTER_STALLED', counter: name, index });
      }
    }
  }
  return { failures, pass: samples.length > 1 && failures.length === 0 };
}

function visualSafety(samples) {
  const failures = [];
  for (const [index, sample] of samples.entries()) {
    if (sample.visual?.black === true) {
      failures.push({ code: 'BLACK_FRAME', index });
    }
    if (
      finite(sample.visual?.freezeDurationMs) &&
      sample.visual.freezeDurationMs > MAX_SAMPLE_GAP_MS
    ) {
      failures.push({
        code: 'FREEZE_BREACH',
        index,
        durationMs: sample.visual.freezeDurationMs,
      });
    }
  }
  return { failures, pass: failures.length === 0 };
}

function pathGate(path, samples) {
  const failures = [];
  for (const [index, sample] of samples.entries()) {
    const local = sample.path?.localCandidateType;
    const remote = sample.path?.remoteCandidateType;
    if (path === 'relay') {
      if (local !== 'relay' || remote !== 'relay') {
        failures.push({ code: 'NON_RELAY_PATH', index });
      }
    } else if (path === 'direct') {
      if (local === 'relay' || remote === 'relay' || !local || !remote) {
        failures.push({ code: 'RELAY_ON_DIRECT_PATH', index });
      }
    } else {
      failures.push({ code: 'INVALID_PATH', index });
    }
  }
  return { path, failures, pass: samples.length > 0 && failures.length === 0 };
}

function bitrateGate(events, publisherSamples) {
  const failures = [];
  for (const target of BITRATE_TARGETS) {
    const event = events.find((candidate) => candidate.target === target);
    if (
      event?.applied !== true ||
      event.peerConnectionIdUnchanged !== true ||
      event.transceiverCountUnchanged !== true ||
      event.screenMidUnchanged !== true ||
      event.negotiationCountUnchanged !== true
    ) {
      failures.push({ code: 'BITRATE_TARGET_NOT_APPLIED', target });
    }
  }
  const twentyMbps = publisherSamples.filter(
    (sample) =>
      sample.targetBitrateBps === 20_000_000 &&
      finite(sample.outbound?.bitrateBps),
  );
  let streak = 0;
  let maximumStreak = 0;
  for (const sample of twentyMbps) {
    const withinTolerance =
      sample.networkLimited !== true &&
      sample.outbound.bitrateBps >= 16_000_000 &&
      sample.outbound.bitrateBps <= 24_000_000;
    streak = withinTolerance ? streak + 1 : 0;
    maximumStreak = Math.max(maximumStreak, streak);
  }
  if (maximumStreak < 3) failures.push({ code: 'BITRATE_20M_TOLERANCE' });
  return {
    maximumTwentyMbpsStreak: maximumStreak,
    failures,
    pass: failures.length === 0,
  };
}

function artifactGate(manifest) {
  const hashes = [
    manifest?.packageSha256,
    manifest?.executableSha256,
    manifest?.asarSha256,
  ];
  const pass =
    manifest?.signatureVerified === true &&
    hashes.every(
      (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
    );
  return { pass };
}

function redactionGate(value) {
  const failures = [];
  const visit = (candidate, path) => {
    if (typeof candidate === 'string') {
      const match = SECRET_PATTERN.exec(candidate);
      if (match !== null) failures.push({ path, match: match[0] });
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      const childPath = `${path}.${key}`;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        failures.push({ path: childPath, match: key });
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(value, '$');
  return {
    pass: failures.length === 0,
    match: failures[0]?.match ?? null,
    failures,
  };
}

export function evaluateP2pGate(input) {
  const publisherSamples = input?.publisherSamples ?? [];
  const receiverSamples = input?.receiverSamples ?? [];
  const durationMs = input?.durationMs ?? 0;
  const checks = {
    separatePhysicalDevices: input?.separatePhysicalDevices === true,
    formalDuration: durationMs >= FORMAL_DURATION_MS,
    publisherTimeline: inspectTimeline(publisherSamples, durationMs),
    receiverTimeline: inspectTimeline(receiverSamples, durationMs),
    captureDimensions: allDimensions(
      publisherSamples,
      (sample) => sample.capture,
    ),
    encodeDimensions: allDimensions(
      publisherSamples,
      (sample) => sample.outbound,
    ),
    decodeDimensions: allDimensions(
      receiverSamples,
      (sample) => sample.inbound,
    ),
    presentationDimensions: allDimensions(
      receiverSamples,
      (sample) => sample.presentation,
    ),
    encodeFps: rollingCounter(
      publisherSamples,
      (sample) => sample.outbound?.framesEncoded,
    ),
    decodeFps: rollingCounter(
      receiverSamples,
      (sample) => sample.inbound?.framesDecoded,
    ),
    presentationFps: rollingCounter(receiverSamples, (sample) =>
      finite(sample.presentation?.totalVideoFrames) &&
      finite(sample.presentation?.droppedVideoFrames)
        ? sample.presentation.totalVideoFrames -
          sample.presentation.droppedVideoFrames
        : null,
    ),
    publisherTransport: stableTransport(publisherSamples),
    receiverTransport: stableTransport(receiverSamples),
    audio: audioContinuity(receiverSamples),
    visual: visualSafety([...publisherSamples, ...receiverSamples]),
    bitrate: bitrateGate(input?.bitrateEvents ?? [], publisherSamples),
    path: pathGate(input?.path, [...publisherSamples, ...receiverSamples]),
    artifacts: artifactGate(input?.artifactManifest),
    redaction: redactionGate({
      publisherSamples,
      receiverSamples,
      bitrateEvents: input?.bitrateEvents,
      artifactManifest: input?.artifactManifest,
    }),
  };
  const pass = Object.values(checks).every((check) =>
    typeof check === 'boolean' ? check : check.pass === true,
  );
  return Object.freeze({
    status: pass ? 'HARDWARE_PASS' : 'GATE_FAILED',
    hardwarePass: pass,
    checks,
  });
}
