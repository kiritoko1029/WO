# 1080p60 Media Lab Matrix

This matrix tracks reproducible hardware validation for the local publisher and receiver lab. Automated tests, a mediasoup Worker smoke, and an Electron build do not satisfy a hardware gate.

## Hardware status

| Platform    | Hardware class  | Automation              | 10-minute media gate | Notes                                                                           |
| ----------- | --------------- | ----------------------- | -------------------- | ------------------------------------------------------------------------------- |
| Windows x64 | Intel graphics  | PENDING                 | NOT RUN              | Requires a physical Intel GPU run.                                              |
| Windows x64 | AMD graphics    | PENDING                 | NOT RUN              | Requires a physical AMD GPU run.                                                |
| Windows x64 | NVIDIA graphics | PASS (local smoke only) | NOT RUN              | Windows 11 64-bit, Intel i7-14700KF, NVIDIA RTX 4080. No capture quality claim. |
| macOS arm64 | Apple Silicon   | PENDING                 | NOT RUN              | Must be run on Apple Silicon with Screen Recording permission.                  |
| macOS x64   | Intel graphics  | PENDING                 | NOT RUN              | Must be run on a 64-bit Intel Mac with Screen Recording permission.             |

The local Windows smoke on 2026-07-15 covered Node 24.12.0 package tests, a real mediasoup 3.20.0 Worker/Router/WebRtcServer lifecycle, and the Electron production bundle. It did not run the interactive 10-minute publisher/receiver gate.

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

## Test material

Use a native 1920 x 1080, 60 Hz display and a continuously changing scene containing all of the following:

- a 60 fps motion region that spans at least half of the frame;
- fine text and high-contrast edges for encoder quality inspection;
- continuous scrolling or panning so repeated or frozen frames are visible;
- a stable on-screen time or frame counter for black-frame and freeze review.

Do not substitute a static desktop or a 30 Hz source for the gate.

## Sampling

Export JSON after the run. Results under `docs/poc/results/` are ignored by Git and must not be committed by default. Each one-second sample records:

- capture settings (`width`, `height`, `frameRate`);
- direction, selected RID, codec, codec implementation, actual bitrate, frames encoded/decoded, output width/height, and derived fps;
- RTT, packet loss, jitter, NACK, and PLI;
- freeze count and `qualityLimitationReason`.

The export contains `samples` and `events`. Every bitrate target event records requested and clamped bitrate, request and apply timestamps, success or failure, a bounded safe error code/message, Producer IDs before and after the attempt, and whether the ID remained unchanged. Error stacks and underlying native error text are not exported.

The first sample and samples after counter resets or a zero/negative time delta have null derived rates and are excluded from the valid-sample denominator. A missing RID or codec implementation is `null`. A failed or deferred bitrate change has `appliedAt: null`; a change made before a Producer exists has null Producer IDs and `producerIdUnchanged: false`.

## Gate

A hardware row passes only when all conditions hold in one uninterrupted run:

1. Publisher and receiver run for at least 10 minutes.
2. Both outbound and inbound video report 1920 x 1080 throughout the measured interval after startup.
3. At least 95% of valid outbound samples and 95% of valid inbound samples report 55 fps or higher.
4. Each 2, 4, 6, and 8 Mbps change settles within 5 seconds and remains stable for three consecutive samples; the Producer ID is unchanged across every change.
5. Neither video view has sustained black output or a freeze lasting more than 2 seconds.
6. `qualityLimitationReason` does not remain `cpu` or `bandwidth` for more than 5 consecutive seconds.
7. The exported JSON, OS build, CPU, GPU, driver, display refresh rate, Electron version, and mediasoup versions are attached to the run record.

Any unmeasured condition leaves the row `NOT RUN` or `PENDING`; automated checks alone never produce a hardware `PASS`.
