# Desktop Packaging Release Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Windows and macOS desktop packaging fail closed on incomplete, unsigned, unnotarized, unsafe, or non-starting production artifacts.

**Architecture:** Keep `electron-builder` as the packager, then independently verify the exact artifact matrix with trusted absolute operating-system tools. Pin Windows publisher/certificate and macOS Team/bundle identities, inspect the real PE/Mach-O payloads inside every final artifact, stream-scan both the complete output tree and extracted ASAR content, verify the packaged Electron fuse wire, and use a tightly validated nonce file to prove that the normal preload/renderer path reached readiness under an isolated profile.

**Tech Stack:** Node.js 24, Electron 43, electron-builder 26, `@electron/asar`, Vitest, PowerShell Authenticode, macOS `codesign`/`spctl`/`stapler`.

---

### Task 1: Define Exact Artifact and Native Trust Gates

**Files:**

- Modify: `apps/desktop/test/package-gates.test.ts`
- Modify: `apps/desktop/scripts/verify-package.mjs`

1. Add failing fixtures proving a signed label cannot validate an unsigned EXE and incomplete target sets fail.
2. Add injectable native-command unit fixtures that cannot be enabled through the production CLI.
3. Require Windows NSIS + portable x64 artifacts and macOS DMG + ZIP for x64 and arm64; inspect PE/Mach-O architecture from extracted payloads instead of trusting names or wrapper architecture.
4. Pin Windows publisher subject/certificate thumbprint and macOS Team ID/bundle ID, using only absolute native-tool paths and a credential-free verification environment.
5. Extract both Windows wrappers, mount every DMG, and extract every ZIP; verify their nested application payload, identity, ASAR equality, and trust with Authenticode or `codesign`/`spctl`/`stapler` as appropriate.
6. Run `pnpm exec vitest run --config vitest.config.ts test/package-gates.test.ts` after each red/green cycle.

### Task 2: Replace Process-Liveness Smoke With an App-Ready Nonce

**Files:**

- Create: `apps/desktop/src/main/package-smoke.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/scripts/verify-package.mjs`
- Modify: `apps/desktop/test/package-gates.test.ts`
- Create: `apps/desktop/test/package-smoke.test.ts`

1. Add failing validation tests for missing flag/env, invalid nonce, paths outside the dedicated temporary directory, and secret-bearing contents.
2. Implement a main-process smoke request that requires flag, env, nonce, and a constrained absolute path; create the normal services and BrowserWindow, load the production preload and renderer, finish session restoration, then write the fixed acknowledgement.
3. Launch with a private temporary user-data directory, wait for the exact acknowledgement, terminate the process tree, await child `close`, and always clean up through a nested `finally`.
4. Smoke both the unpacked Windows app and final portable executable, plus the host-architecture application nested inside each macOS DMG/ZIP.

### Task 3: Close Package Content Scanner Bypasses

**Files:**

- Modify: `apps/desktop/test/package-gates.test.ts`
- Modify: `apps/desktop/scripts/verify-package.mjs`

1. Add failing tests for encrypted PKCS#8 PEM, key files outside ASAR, symlinks, and renderer Node built-in imports.
2. Stream-scan the complete package output and extracted ASAR payload with bounded memory and overlap across chunks; never skip candidate text because of file size.
3. Recognize encrypted/private-key PEM variants and reject renderer `node:`/CommonJS built-in imports.
4. Re-run all package-gate fixtures.

### Task 4: Align Signing Inputs and Harden Electron Fuses

**Files:**

- Modify: `apps/desktop/test/package-config.test.ts`
- Modify: `apps/desktop/test/package-gates.test.ts`
- Modify: `apps/desktop/scripts/build-platform.mjs`
- Modify: `apps/desktop/electron-builder.yml`

1. Add failing tests for unsupported Windows name-only signing and profile-only Apple keychain notarization.
2. Accept only signing providers consumed by electron-builder 26; allow an Apple keychain profile without a separate keychain path.
3. Configure production Electron fuses to disable RunAsNode/Node CLI controls and require ASAR loading/integrity, then read and enforce those states from every packaged Electron binary.
4. Verify generated plans contain no secrets and unsigned-development overrides remain explicit.

### Task 5: Full Verification and Real Unsigned Windows Package

**Files:**

- Verify only; no new production files.

1. Run focused package and smoke tests.
2. Run desktop typecheck, lint, build, and formatting checks.
3. Build a real Windows x64 unsigned-development package and run the strengthened verifier/smoke.
4. Inspect the packaged ASAR, extracted installer/portable payloads, and Electron fuse state, then run `git diff --check`.
5. Report macOS signed/notarized verification as pending unless run on a native credentialed macOS runner.
