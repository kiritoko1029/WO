import { AudioLines, Mic, MonitorUp, Server } from 'lucide-react';

/** Product introduction shared by the desktop and browser sign-in screen. */
export function WelcomePanel() {
  return (
    <section className="welcome-panel" aria-labelledby="welcome-title">
      <div className="welcome-eyebrow">
        <span className="product-mark" aria-hidden="true">
          <AudioLines size={20} />
        </span>
        <span>
          WO <span className="welcome-eyebrow-divider">/</span> 一起，就在此刻
        </span>
      </div>
      <h2 id="welcome-title">
        听见彼此。
        <br />
        <span>看见同一个世界。</span>
      </h2>
      <p className="welcome-description">
        一个只属于两个人的空间。聊聊天，分享屏幕，
        <br className="welcome-break" />
        让每一次远程相聚，都近一点。
      </p>
      <div className="welcome-visual" aria-hidden="true">
        <div className="welcome-orbit" />
        <div className="welcome-peer welcome-peer-self">
          <span>我</span>
          <Mic size={15} />
        </div>
        <div className="welcome-wave">
          {[12, 24, 38, 22, 50, 32, 18, 40, 28, 14].map((height, index) => (
            <i key={index} style={{ height }} />
          ))}
        </div>
        <div className="welcome-peer welcome-peer-friend">
          <span>你</span>
          <AudioLines size={16} />
        </div>
        <div className="welcome-share">
          <MonitorUp size={17} />
          <span>分享眼前，连接彼此</span>
        </div>
      </div>
      <ul className="welcome-features">
        <li>
          <Mic size={17} aria-hidden="true" />
          <span>双人语音</span>
        </li>
        <li>
          <MonitorUp size={17} aria-hidden="true" />
          <span>屏幕共享</span>
        </li>
        <li>
          <Server size={17} aria-hidden="true" />
          <span>自由自托管</span>
        </li>
      </ul>
    </section>
  );
}
