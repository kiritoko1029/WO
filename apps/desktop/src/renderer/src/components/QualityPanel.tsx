import { useState } from 'react';
import { Activity, X } from 'lucide-react';

import type { QualityDiagnosticSample } from '../media/stats-buffer.js';

function number(value: number | null, digits = 0): string {
  return value === null ? '--' : value.toFixed(digits);
}

function bitrate(value: number | null): string {
  return value === null ? '--' : `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function mediaLine(media: QualityDiagnosticSample['outbound']): string {
  if (media === null) return '--';
  return `${bitrate(media.bitrateBps)} · ${number(media.fps)} fps`;
}

function captureLine(sample: QualityDiagnosticSample | null): string {
  const capture = sample?.capture;
  if (capture === null || capture === undefined) return '--';
  return `${number(capture.width)} x ${number(capture.height)} · ${number(capture.frameRate)} fps`;
}

function pathLine(sample: QualityDiagnosticSample | null): string {
  if (sample === null || sample.path.candidateType === 'unknown') return '--';
  const route =
    sample.path.candidateType === 'relay' ? 'TURN 中继' : '端到端直连';
  return `${route} · ${sample.path.protocol.toUpperCase()}`;
}

export function QualityPanel({
  sample,
}: {
  readonly sample: QualityDiagnosticSample | null;
}) {
  const [open, setOpen] = useState(false);
  const outbound = sample?.outbound ?? null;
  const inbound = sample?.inbound ?? null;

  return (
    <div className="quality-control">
      <button
        type="button"
        className="quality-toggle"
        aria-label="连接质量"
        aria-expanded={open}
        title="连接质量"
        onClick={() => setOpen((current) => !current)}
      >
        <Activity size={16} />
      </button>
      {open && (
        <section className="quality-panel" aria-label="连接质量详情">
          <header>
            <strong>连接质量</strong>
            <button
              type="button"
              aria-label="关闭连接质量"
              title="关闭"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <dl>
            <div>
              <dt>链路</dt>
              <dd>{pathLine(sample)}</dd>
            </div>
            <div>
              <dt>实际采集</dt>
              <dd>{captureLine(sample)}</dd>
            </div>
            <div>
              <dt>目标码率</dt>
              <dd>{bitrate(sample?.targetBitrateBps ?? null)}</dd>
            </div>
            <div>
              <dt>实际发送</dt>
              <dd>{mediaLine(outbound)}</dd>
            </div>
            <div>
              <dt>实际接收</dt>
              <dd>{mediaLine(inbound)}</dd>
            </div>
            <div>
              <dt>画面展示</dt>
              <dd>{number(sample?.presentationFps ?? null)} fps</dd>
            </div>
            <div>
              <dt>接收丢包</dt>
              <dd>{number(inbound?.lossPercent ?? null, 1)}%</dd>
            </div>
            <div>
              <dt>往返延迟</dt>
              <dd>{number(outbound?.rttMs ?? inbound?.rttMs ?? null)} ms</dd>
            </div>
            <div>
              <dt>编码</dt>
              <dd>{outbound?.codec ?? inbound?.codec ?? '--'}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
