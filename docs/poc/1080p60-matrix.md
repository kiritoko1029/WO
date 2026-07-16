# 1080p60 Media Lab Matrix

> Current product certification status (P2P): **NOT CERTIFIED**. The table below begins with legacy same-host SFU evidence and must not be used as evidence for the current two-person P2P product. The current P2P claim matrix is maintained in [../support-matrix.md](../support-matrix.md); every row remains `NOT TESTED` until the Task 17 two-physical-device harness records a 45-second preflight and a separate 600-second formal run.

This matrix tracks reproducible hardware validation for the local publisher and receiver lab. Automated tests, a mediasoup Worker smoke, and an Electron build do not satisfy a hardware gate.

## Hardware status

| Platform    | Hardware class  | Automation | Hardware preflight | 10-minute media gate | Notes                                                                                                |
| ----------- | --------------- | ---------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------- |
| Windows x64 | Intel graphics  | PENDING    | NOT RUN            | NOT RUN              | Requires a physical Intel GPU run.                                                                   |
| Windows x64 | AMD graphics    | PENDING    | NOT RUN            | NOT RUN              | Requires a physical AMD GPU run.                                                                     |
| Windows x64 | NVIDIA graphics | PASS       | FAIL (45 s)        | NOT RUN              | Windows 11, i7-14700KF, RTX 4080; receiver presentation reached 55 fps in 60.47% of rolling windows. |
| macOS arm64 | Apple Silicon   | PENDING    | NOT RUN            | NOT RUN              | Must be run on Apple Silicon with Screen Recording permission.                                       |
| macOS x64   | Intel graphics  | PENDING    | NOT RUN            | NOT RUN              | Must be run on a 64-bit Intel Mac with Screen Recording permission.                                  |

The local Windows automation covers Node 24.12.0 package tests, a real mediasoup 3.20.0 Worker/Router/WebRtcServer lifecycle, and the Electron production bundle. The NVIDIA row also has a strict 45-second publisher/receiver preflight. That preflight failed, and automated checks never satisfy the 10-minute hardware gate.

## Observed Windows candidate (not certified)

The observed Windows NVIDIA candidate uses this exact publishing path:

- one 1920 x 1080, 60 fps encoding with RID `f`, `L1T1`, and no 720p simulcast layer;
- the Router advertises H.264 Baseline `42002a` first and `42e01f` as an unvalidated compatibility fallback;
- the actual Windows sender negotiation reports H.264 Baseline `profile-level-id=42001f`, not the Router's offered `42002a` level;
- `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, reported as a power-efficient hardware encoder;
- mediasoup forwards the encoded stream without transcoding;
- VP8 and VP9 remain available only as manual fallback choices.

The latest strict preflight ran a separate 2/4/6/8 Mbps transition phase followed by a 45.002-second quality interval at 8 Mbps. Publisher and receiver remained at 1920 x 1080. All four events used the same Producer ID, each sender maximum was visible for five consecutive samples and applied in 1 ms, and actual outbound bitrate at 8 Mbps remained within the 6.4-9.6 Mbps tolerance for four consecutive samples.

The publisher encoded at least 55 fps in 43/43 two-second rolling windows, with a minimum of 55.2486 fps. The receiver decoded at least 55 fps in 42/43 windows (97.67%), but after subtracting `droppedVideoFrames` from `totalVideoFrames`, only 26/43 presentation windows (60.47%) reached 55 fps, with a minimum of 50.8475 fps. Both roles had complete 45/45 one-second stats, video-analysis, counter-sample, and valid-window coverage, with no counter reset, invalid/oversized counter window, sustained black output, freeze, or sustained CPU/bandwidth quality limitation. The correct result is therefore `GATE_FAILED`, not a preflight pass.

All 21 raw codec samples, including the post-quality check, reported `video/H264`, negotiated `profile-level-id=42001f`, `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`, and `powerEfficientEncoder=true`. All 45 quality-phase product samples reported the same MIME and encoder implementation. This validates the observed hardware codec path, but it does not turn the failed presentation result into a pass. It also means the actual run must not be described as negotiated `42002a`; verifying the H.264 bitstream SPS level would require additional packet/bitstream evidence.

The current Windows harness deliberately freezes `42001f` as its expected negotiated fmtp because that is the observed Chromium sender capability. It does not certify a Level 4.2 bitstream or mobile H.264 interoperability. Those claims require separate SPS/bitstream and target-device evidence rather than inference from the Router's `42002a` capability.

The fixed two-layer `q/f` candidate was removed because the blocking PoC did not preserve full-resolution 60 fps behavior on this hardware path. This is an architecture result, not a completed hardware certification. The current harness captures a 1920 x 1080 application window; it does not certify whole-monitor capture. macOS has not been tested on physical hardware, and its default encoder path remains undecided.

## Reproducible setup

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @wo/media-lab-server cert:generate
pnpm --filter @wo/media-lab-server build
pnpm --filter @wo/media-lab-desktop build
```

Start the WSS server in one terminal:

```powershell
$env:MEDIA_LAB_CERT_DIR = ".certs/media-lab"
pnpm --filter @wo/media-lab-server start
```

Start both Electron roles in another terminal:

```powershell
$env:MEDIA_LAB_ALLOW_SELF_SIGNED = "1"
$env:MEDIA_LAB_URL = "wss://127.0.0.1:4443"
pnpm --filter @wo/media-lab-desktop dev
```

Use `-- --role=publisher` or `-- --role=receiver` to launch one role. The server and WSS endpoint bind only to `127.0.0.1`. Do not use a global TLS bypass.

For the automated Windows preflight, run:

```powershell
node docs/poc/hardware-gate-harness.mjs --preflight
```

The same harness accepts a formal-duration request:

```powershell
node docs/poc/hardware-gate-harness.mjs --duration=600
```

This command alone cannot establish certification: the current legacy SFU harness starts both roles on one Windows host and validates a window source. Even when every media metric passes for 600 seconds, that scope is recorded only as `EXPERIMENT_PASS` with `hardwarePass=false`. This harness reserves `HARDWARE_PASS` for evidence from separate physical devices and its planned monitor-source whole-desktop mode. That scope rule belongs to this legacy whole-desktop PoC; the later P2P acceptance matrix certifies window and monitor sources separately. Equivalent physical-device tooling is also required on macOS. `--proxy-server=<url>` is optional when an explicit Chromium proxy is required; loopback media and signaling addresses remain in the proxy bypass list.

## Test material

Use a continuously changing 1920 x 1080, 60 fps source containing all of the following:

- a 60 fps motion region that spans at least half of the frame;
- fine text and high-contrast edges for encoder quality inspection;
- continuous scrolling or panning so repeated or frozen frames are visible;
- a stable on-screen time or frame counter for black-frame and freeze review.

Do not substitute a static desktop or a 30 Hz source for the gate.

The current automated source is a generated 1920 x 1080 application window displayed on a 2560 x 1440, 359 Hz monitor. A whole-monitor gate must use a monitor source and separately verify the resulting capture settings.

The legacy motion source advances its logical frame counter when a delayed `requestAnimationFrame` callback must catch up, but it does not independently export actual draw callback timestamps or a draw count. The present evidence therefore does not certify 60 unique source draws per second. Receiver presentation and visual-analysis gates measure the delivered media outcome, but they do not replace source-cadence evidence. The new P2P acceptance harness in Task 17 must record that cadence explicitly.

## Sampling

Export JSON after the run. Results under `docs/poc/results/` are ignored by Git and must not be committed by default. Each one-second sample records:

- capture settings (`width`, `height`, `frameRate`);
- direction, selected RID, codec, negotiated H.264 fmtp, codec implementation, power-efficient encoder flag, actual bitrate, frames encoded/decoded, output width/height, and derived fps;
- playback `totalVideoFrames`, `droppedVideoFrames`, and the derived presented-frame rate;
- RTT, packet loss, jitter, NACK, and PLI;
- freeze count and `qualityLimitationReason`.

The export contains `samples` and `events`. Every bitrate target event records requested and clamped bitrate, request and apply timestamps, success or failure, a bounded safe error code/message, Producer IDs before and after the attempt, and whether the ID remained unchanged. Error stacks and underlying native error text are not exported.

The first sample and samples after counter resets or a zero/negative time delta have null derived rates and are excluded from the valid-sample denominator. A missing RID or codec implementation is `null`. A failed or deferred bitrate change has `appliedAt: null`; a change made before a Producer exists has null Producer IDs and `producerIdUnchanged: false`.

The frame-rate gate uses two-second rolling rates calculated from cumulative encoded/decoded frame counters. Receiver presentation uses `totalVideoFrames - droppedVideoFrames` over the same window. Both counter families require at least 95% sample and valid-window coverage, reject any counter reset or non-positive interval, and reject windows spanning more than 2.5 seconds. Every timeline is validated in its original exported order before metrics are calculated: empty or insufficient series, invalid timestamps, duplicate or out-of-order timestamps, and a measurement end that is not strictly after the last sample fail closed with machine-readable reason codes. The evaluator never sorts malformed input into apparent validity. Black, frozen, and CPU/bandwidth-limited intervals are measured from the first matching sample timestamp through the first recovery sample, or through the measurement end when no recovery sample exists; irregular samples are never treated as fixed one-second units. The separate temporal-coverage gate still rejects sampling gaps over 2 seconds. The native `framesPerSecond` gauge is retained as supporting evidence but does not replace either counter gate.

## Gate

A hardware row passes only when the bitrate transition phase and subsequent quality interval complete without recreating the Producer, and all conditions below hold:

1. After the final 8 Mbps transition settles, publisher and receiver run the measured quality interval for at least 10 uninterrupted minutes.
2. Both outbound and inbound video report 1920 x 1080 throughout the measured interval after startup.
3. At least 95% of valid outbound encoded, inbound decoded, and receiver presented two-second rolling counter windows report 55 fps or higher.
4. Each configured 2, 4, 6, and 8 Mbps sender maximum settles within 5 seconds and remains stable for three consecutive samples at the nominal one-second cadence: every adjacent pair must be 750-2,000 ms apart and the three-sample span must be at least 1,500 ms. All events reference one unchanged Producer ID. At 8 Mbps, actual outbound bitrate must also enter the defined no-congestion tolerance for three samples under the same cadence and span rules.
5. Neither video view has sustained black output or a freeze lasting more than 2 seconds.
6. `qualityLimitationReason` does not remain `cpu` or `bandwidth` for more than 5 consecutive seconds.
7. The exported JSON, OS build, CPU, GPU, driver, display refresh rate, Electron version, and mediasoup versions are attached to the run record.
8. The run reports the expected negotiated codec/profile, a non-empty encoder implementation, and `powerEfficientEncoder=true` during the bitrate stage and the post-quality check; every quality-stage product sample must retain the same MIME and encoder implementation.

Any unmeasured condition leaves the row `NOT RUN` or `PENDING`; automated checks alone never produce a hardware `PASS`.

## Next required run

1. Add a distributed runner, then run the same 45-second preflight with publisher and receiver on separate physical Windows devices while keeping the SFU self-hosted.
2. If both roles meet the strict preflight, run the 600-second formal gate without changing thresholds.
3. Repeat with a monitor source to certify whole-desktop sharing, then cover Intel/AMD Windows hardware.
4. Implement the equivalent runner and repeat the preflight and formal gate on Apple Silicon macOS.

The present data makes co-located resource contention a plausible explanation for the receiver result, but it does not prove that cause: no same-host/separate-host A/B run or synchronized CPU/GPU encode/decode utilization was collected.
