import { useMemo, useState } from 'react';
import { Apple, ChevronDown, ChevronUp, Download, Monitor } from 'lucide-react';

type Platform = 'mac' | 'win' | 'other';

interface DownloadOption {
  readonly label: string;
  readonly href: string;
  readonly icon: 'apple' | 'monitor';
  readonly hint: string;
}

function detectPlatform(userAgent: string): Platform {
  const lower = userAgent.toLowerCase();
  if (lower.includes('mac')) return 'mac';
  if (lower.includes('win')) return 'win';
  return 'other';
}

function downloadOptionsFor(platform: Platform): {
  primary: DownloadOption;
  secondary: DownloadOption[];
} {
  const macArm: DownloadOption = {
    label: 'macOS (Apple 芯片)',
    href: '/download/WO-mac-arm64.dmg',
    icon: 'apple',
    hint: 'M1/M2/M3/M4',
  };
  const winSetup: DownloadOption = {
    label: 'Windows 安装版',
    href: '/download/WO-win-x64-setup.exe',
    icon: 'monitor',
    hint: '推荐',
  };
  const winPortable: DownloadOption = {
    label: 'Windows 便携版',
    href: '/download/WO-win-x64-portable.exe',
    icon: 'monitor',
    hint: '免安装',
  };
  const macZip: DownloadOption = {
    label: 'macOS (.zip)',
    href: '/download/WO-mac-arm64.zip',
    icon: 'apple',
    hint: 'Apple 芯片',
  };

  if (platform === 'mac') {
    return {
      primary: macArm,
      secondary: [winSetup, winPortable, macZip],
    };
  }
  if (platform === 'win') {
    return {
      primary: winSetup,
      secondary: [macArm, winPortable, macZip],
    };
  }
  // Unknown platform — show macOS first (common for developers).
  return {
    primary: macArm,
    secondary: [winSetup, winPortable, macZip],
  };
}

function OptionIcon({ option }: { readonly option: DownloadOption }) {
  return option.icon === 'apple' ? (
    <Apple size={18} aria-hidden="true" />
  ) : (
    <Monitor size={18} aria-hidden="true" />
  );
}

/**
 * Desktop-client download card, shown on the web home page only (hidden in the
 * Electron desktop app, where `window.woShell` is defined by the preload).
 *
 * Auto-detects the visitor's OS from the user agent and surfaces the matching
 * installer as the primary action, with a collapsible list of other platforms.
 */
export function DownloadClient() {
  // The desktop preload injects `window.woShell`. In the packaged desktop app
  // it is always present, so this component self-hides there.
  if (typeof window !== 'undefined' && window.woShell !== undefined) {
    return null;
  }

  return <DownloadCard />;
}

function DownloadCard() {
  const platform = useMemo(
    () =>
      detectPlatform(
        typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ),
    [],
  );
  const { primary, secondary } = useMemo(
    () => downloadOptionsFor(platform),
    [platform],
  );
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="download-client" aria-labelledby="download-title">
      <span className="action-icon indigo" aria-hidden="true">
        <Download size={22} />
      </span>
      <div className="download-client-main">
        <h2 id="download-title">桌面客户端</h2>
        <p>下载原生客户端，获得更稳定的屏幕共享体验</p>
        <a
          className="primary-button download-client-primary"
          href={primary.href}
          download
        >
          <OptionIcon option={primary} />
          <span>下载{primary.label}</span>
          {primary.hint.length > 0 && (
            <span className="download-client-hint">{primary.hint}</span>
          )}
        </a>
        <button
          type="button"
          className="download-client-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
          其他平台
        </button>
        {expanded && (
          <ul className="download-client-others">
            {secondary.map((option) => (
              <li key={option.href}>
                <a href={option.href} download>
                  <OptionIcon option={option} />
                  <span>{option.label}</span>
                  {option.hint.length > 0 && (
                    <span className="download-client-hint">{option.hint}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
