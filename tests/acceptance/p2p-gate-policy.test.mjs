import { describe, expect, test } from 'vitest';

import {
  evaluateP2pGate,
  FORMAL_DURATION_MS,
} from '../../scripts/acceptance/p2p-gate-policy.mjs';

const hash = 'a'.repeat(64);

function passingFixture() {
  const publisherSamples = [];
  const receiverSamples = [];
  for (let second = 0; second <= 600; second += 1) {
    const timestampMs = second * 1_000;
    const common = {
      timestampMs,
      peerConnectionId: 'pc-1',
      transceiverCount: 2,
      screenMid: '1',
      negotiationCount: 1,
      targetBitrateBps: 8_000_000,
      networkLimited: false,
      path: { localCandidateType: 'host', remoteCandidateType: 'srflx' },
      visual: { black: false, freezeDurationMs: 0 },
    };
    publisherSamples.push({
      ...common,
      capture: { width: 1_920, height: 1_080, frameRate: 60 },
      outbound: {
        width: 1_920,
        height: 1_080,
        framesEncoded: second * 60,
        bitrateBps: 8_000_000,
      },
    });
    receiverSamples.push({
      ...common,
      inbound: {
        width: 1_920,
        height: 1_080,
        framesDecoded: second * 60,
      },
      presentation: {
        width: 1_920,
        height: 1_080,
        totalVideoFrames: second * 60,
        droppedVideoFrames: 0,
      },
      audio: {
        packetsReceived: second + 1,
        totalSamplesReceived: (second + 1) * 48_000,
        totalAudioEnergy: (second + 1) * 0.25,
      },
    });
  }
  return {
    durationMs: FORMAL_DURATION_MS,
    separatePhysicalDevices: true,
    path: 'direct',
    publisherSamples,
    receiverSamples,
    bitrateEvents: ['auto', 2, 4, 6, 8].map((target) => ({
      target,
      applied: true,
      peerConnectionIdUnchanged: true,
      transceiverCountUnchanged: true,
      screenMidUnchanged: true,
      negotiationCountUnchanged: true,
    })),
    artifactManifest: {
      signatureVerified: true,
      packageSha256: hash,
      executableSha256: hash,
      asarSha256: hash,
    },
  };
}

describe('P2P hardware gate policy', () => {
  test('passes only complete two-device 600-second 1080p60 evidence', () => {
    expect(evaluateP2pGate(passingFixture())).toMatchObject({
      status: 'HARDWARE_PASS',
      hardwarePass: true,
      checks: {
        encodeFps: { passingRatio: 1, pass: true },
        presentationFps: { passingRatio: 1, pass: true },
        audio: { pass: true },
        bitrate: { pass: true },
        path: { pass: true },
      },
    });
  });

  test.each([
    ['short duration', (fixture) => (fixture.durationMs = 599_000)],
    [
      'co-located clients',
      (fixture) => (fixture.separatePhysicalDevices = false),
    ],
    [
      'capture below 1080p',
      (fixture) => (fixture.publisherSamples[20].capture.width = 1_280),
    ],
    [
      'presentation below 55 fps',
      (fixture) => {
        for (const sample of fixture.receiverSamples) {
          sample.presentation.totalVideoFrames =
            Math.floor(sample.timestampMs / 1_000) * 50;
        }
      },
    ],
    [
      'counter reset',
      (fixture) => (fixture.publisherSamples[300].outbound.framesEncoded = 1),
    ],
    ['long sample gap', (fixture) => fixture.receiverSamples.splice(200, 3)],
    [
      'audio stall',
      (fixture) => {
        fixture.receiverSamples[50].audio.totalAudioEnergy =
          fixture.receiverSamples[49].audio.totalAudioEnergy;
      },
    ],
    [
      'transport identity change',
      (fixture) => (fixture.publisherSamples[100].peerConnectionId = 'pc-2'),
    ],
    [
      'bitrate renegotiation',
      (fixture) => (fixture.bitrateEvents[2].negotiationCountUnchanged = false),
    ],
    [
      'black frame',
      (fixture) => (fixture.receiverSamples[100].visual.black = true),
    ],
    [
      'unsigned artifact',
      (fixture) => (fixture.artifactManifest.signatureVerified = false),
    ],
  ])('fails closed for %s', (_name, mutate) => {
    const fixture = passingFixture();
    mutate(fixture);
    expect(evaluateP2pGate(fixture)).toMatchObject({
      status: 'GATE_FAILED',
      hardwarePass: false,
    });
  });

  test('requires every forced-relay sample to use relay on both sides', () => {
    const fixture = passingFixture();
    fixture.path = 'relay';
    for (const sample of [
      ...fixture.publisherSamples,
      ...fixture.receiverSamples,
    ]) {
      sample.path = {
        localCandidateType: 'relay',
        remoteCandidateType: 'relay',
      };
    }
    expect(evaluateP2pGate(fixture).checks.path.pass).toBe(true);

    fixture.receiverSamples[300].path.localCandidateType = 'srflx';
    expect(evaluateP2pGate(fixture)).toMatchObject({
      status: 'GATE_FAILED',
      checks: { path: { pass: false } },
    });
  });

  test('rejects privacy-sensitive evidence fields', () => {
    const fixture = passingFixture();
    fixture.receiverSamples[1].debug = 'candidate 192.168.1.20';
    expect(evaluateP2pGate(fixture)).toMatchObject({
      status: 'GATE_FAILED',
      checks: { redaction: { pass: false } },
    });
  });
});
