// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CallToolbar } from '../src/renderer/src/components/CallToolbar.js';
import { QualityPanel } from '../src/renderer/src/components/QualityPanel.js';
import { ScreenShareToolbar } from '../src/renderer/src/components/ScreenShareToolbar.js';
import { ScreenStage } from '../src/renderer/src/components/ScreenStage.js';
import { SourcePicker } from '../src/renderer/src/components/SourcePicker.js';

afterEach(cleanup);

const sources = [
  {
    token: '550e8400-e29b-41d4-a716-446655440000',
    name: '主显示器',
    kind: 'screen' as const,
    thumbnailDataUrl: 'data:image/png;base64,AA==',
  },
  {
    token: '550e8400-e29b-41d4-a716-446655440001',
    name: '设计稿',
    kind: 'window' as const,
    thumbnailDataUrl: 'data:image/png;base64,AQ==',
  },
];

describe('desktop share controls', () => {
  it('keeps privacy-safe actual quality metrics collapsed by default', async () => {
    const user = userEvent.setup();
    render(
      <QualityPanel
        sample={{
          timestampMs: 2_000,
          negotiationGeneration: 3,
          path: { candidateType: 'relay', protocol: 'udp' },
          capture: { width: 1_920, height: 1_080, frameRate: 60 },
          targetBitrateBps: 4_000_000,
          outbound: {
            bitrateBps: 3_800_000,
            fps: 58,
            width: 1_920,
            height: 1_080,
            lossPercent: 0.4,
            rttMs: 28,
            jitterMs: 4,
            codec: 'video/H264',
            nackCount: 2,
            pliCount: 1,
            freezeCount: null,
          },
          inbound: {
            bitrateBps: 3_600_000,
            fps: 57,
            width: 1_920,
            height: 1_080,
            lossPercent: 0.7,
            rttMs: null,
            jitterMs: 5,
            codec: 'video/H264',
            nackCount: null,
            pliCount: null,
            freezeCount: 0,
          },
          presentationFps: 56,
        }}
      />,
    );

    expect(screen.queryByLabelText('连接质量详情')).toBeNull();
    await user.click(screen.getByRole('button', { name: '连接质量' }));

    expect(screen.getByLabelText('连接质量详情')).toBeTruthy();
    expect(screen.getByText('TURN 中继 · UDP')).toBeTruthy();
    expect(screen.getByText('1920 x 1080 · 60 fps')).toBeTruthy();
    expect(screen.getByText('3.80 Mbps · 58 fps')).toBeTruthy();
    expect(screen.getByText('3.60 Mbps · 57 fps')).toBeTruthy();
    expect(screen.getByText('56 fps')).toBeTruthy();
    expect(screen.getByText('28 ms')).toBeTruthy();
  });

  it('keeps source selection separate from the start gesture', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <SourcePicker
        sources={sources}
        selectedToken={null}
        state="picking"
        onSelect={onSelect}
        onStart={onStart}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: /主显示器/ }));
    expect(onSelect).toHaveBeenCalledWith(sources[0]!.token);
    expect(onStart).not.toHaveBeenCalled();

    rerender(
      <SourcePicker
        sources={sources}
        selectedToken={sources[0]!.token}
        state="picking"
        onSelect={onSelect}
        onStart={onStart}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: '开始共享' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('offers quality tiers as max-bitrate ceilings and stats behind a toggle', async () => {
    const user = userEvent.setup();
    const onTargetChange = vi.fn();
    render(
      <ScreenShareToolbar
        settings={{ width: 1_920, height: 1_080, frameRate: 60 }}
        target={{ mode: 'fixed', bitrateBps: 10_000_000 }}
        pending={null}
        error={null}
        quality={{
          timestampMs: 2_000,
          negotiationGeneration: 3,
          path: { candidateType: 'host', protocol: 'udp' },
          capture: { width: 1_920, height: 1_080, frameRate: 60 },
          targetBitrateBps: 10_000_000,
          outbound: {
            bitrateBps: 7_500_000,
            fps: 58,
            width: 1_920,
            height: 1_080,
            lossPercent: 0.2,
            rttMs: 24,
            jitterMs: 3,
            codec: 'video/H264',
            nackCount: 1,
            pliCount: 0,
            freezeCount: null,
          },
          inbound: null,
          presentationFps: 56,
        }}
        onTargetChange={onTargetChange}
      />,
    );

    expect(screen.queryByLabelText('传输信息详情')).toBeNull();
    await user.click(screen.getByRole('button', { name: '传输信息' }));
    expect(screen.getByLabelText('传输信息详情')).toBeTruthy();
    expect(screen.getByText('1920 x 1080')).toBeTruthy();
    expect(screen.getByText('60 fps')).toBeTruthy();
    expect(screen.getByText('7.50 Mbps')).toBeTruthy();
    expect(screen.getByText('24 ms')).toBeTruthy();

    const select = screen.getByLabelText('码率上限') as HTMLSelectElement;
    expect(select.value).toBe('10000000');
    await user.selectOptions(select, '5000000');
    expect(onTargetChange).toHaveBeenCalledWith({
      mode: 'fixed',
      bitrateBps: 5_000_000,
    });
  });

  it('disables the share action while the remote peer owns it', () => {
    render(
      <CallToolbar
        busy={false}
        muted={false}
        outputMuted={false}
        inputs={[]}
        outputs={[]}
        selectedInputId=""
        selectedOutputId=""
        supportsOutputSelection={false}
        retryAvailable={false}
        screenState="idle"
        screenDisabled
        screenOwnerName="林远"
        onScreenShare={vi.fn()}
        onHangup={vi.fn()}
        onMutedChange={vi.fn()}
        onInputChange={vi.fn()}
        onOutputChange={vi.fn()}
        onOutputMutedChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const share = screen.getByRole('button', { name: '林远正在共享' });
    expect((share as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not show a pre-negotiated receiver track until a remote owner exists', () => {
    const track = { kind: 'video' } as MediaStreamTrack;
    const { rerender } = render(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName={null}
        remoteBitrateBps={null}
      />,
    );

    expect(screen.queryByLabelText('对方的共享屏幕')).toBeNull();
    expect(screen.getByText('等待屏幕共享')).toBeTruthy();
    expect(screen.queryByLabelText('画面控制')).toBeNull();

    rerender(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="sharing"
        remoteOwnerName={null}
        remoteBitrateBps={null}
      />,
    );
    expect(screen.queryByLabelText('对方的共享屏幕')).toBeNull();
    expect(screen.getByText('您正在共享屏幕')).toBeTruthy();

    rerender(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName="林远"
        remoteBitrateBps={null}
      />,
    );
    expect(screen.getByLabelText('林远的共享屏幕')).toBeTruthy();
    expect(screen.getByLabelText('画面控制')).toBeTruthy();
    expect(screen.getByRole('button', { name: '全屏展示' })).toBeTruthy();
  });

  it('previews the local screen track while sharing', () => {
    const track = { kind: 'video' } as MediaStreamTrack;
    render(
      <ScreenStage
        localTrack={track}
        remoteTrack={null}
        localState="sharing"
        remoteOwnerName={null}
        remoteBitrateBps={null}
      />,
    );

    const preview = screen.getByLabelText('本地共享预览');
    expect(preview.tagName).toBe('VIDEO');
    expect((preview as HTMLVideoElement).muted).toBe(true);
    expect(screen.queryByText('您正在共享屏幕')).toBeNull();
    expect(screen.getByLabelText('画面控制')).toBeTruthy();
  });

  it('zooms the receiver toward the cursor on wheel and resets via toolbar', async () => {
    const user = userEvent.setup();
    const track = { kind: 'video' } as MediaStreamTrack;
    render(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName="林远"
        remoteBitrateBps={null}
      />,
    );

    const stage = document.querySelector('.screen-stage') as HTMLElement;
    const video = screen.getByLabelText('林远的共享屏幕') as HTMLVideoElement;
    expect(video.style.transform).toBe('translate(0px, 0px) scale(1)');

    // Wheel up should zoom in. stage needs a measurable rect for the
    // cursor-anchored calculation.
    stage.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }) as DOMRect;
    await act(async () => {
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300 }),
      );
    });

    expect(video.style.transform).toContain('scale(');
    expect(video.style.transform).not.toBe('translate(0px, 0px) scale(1)');

    // Reset button only appears after zoom.
    const resetBtn = screen.getByRole('button', { name: '还原缩放' });
    await user.click(resetBtn);
    expect(video.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('does not show the reset control before zoom', () => {
    const track = { kind: 'video' } as MediaStreamTrack;
    render(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName="林远"
        remoteBitrateBps={null}
      />,
    );
    expect(screen.queryByRole('button', { name: '还原缩放' })).toBeNull();
  });

  it('resets zoom on double click', async () => {
    const track = { kind: 'video' } as MediaStreamTrack;
    render(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName="林远"
        remoteBitrateBps={null}
      />,
    );

    const stage = document.querySelector('.screen-stage') as HTMLElement;
    stage.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }) as DOMRect;
    const video = screen.getByLabelText('林远的共享屏幕') as HTMLVideoElement;

    await act(async () => {
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 150 }),
      );
    });
    expect(video.style.transform).not.toBe('translate(0px, 0px) scale(1)');

    fireEvent.dblClick(video);
    expect(video.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('requests fullscreen on the video element when toggling fullscreen', () => {
    const track = { kind: 'video' } as MediaStreamTrack;
    render(
      <ScreenStage
        localTrack={null}
        remoteTrack={track}
        localState="idle"
        remoteOwnerName="林远"
        remoteBitrateBps={null}
      />,
    );

    const video = screen.getByLabelText('林远的共享屏幕') as HTMLVideoElement;
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    video.requestFullscreen = requestFullscreen as unknown as typeof video.requestFullscreen;

    fireEvent.click(screen.getByRole('button', { name: '全屏展示' }));
    expect(requestFullscreen).toHaveBeenCalled();
  });
});
