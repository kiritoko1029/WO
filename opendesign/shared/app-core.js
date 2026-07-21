/* Shared WO prototype state + render helpers */
(function () {
  const I = () => window.WOIcons;

  const DEFAULT = {
    route: 'auth', // auth | home | room
    authMode: 'login', // login | register | verify
    email: 'chen@example.com',
    password: '',
    displayName: '陈响',
    code: '',
    authError: '',
    busy: false,
    user: null, // { displayName, email }
    roomCode: '',
    joinCode: '',
    homeError: '',
    connection: 'connected', // connecting | connected | reconnecting | failed
    muted: false,
    outputMuted: false,
    screen: 'idle', // idle | picking | sharing
    shareMenu: false,
    copied: null,
    quality: { rtt: 28, loss: 0.1, bitrate: 2.4 },
    bitrateTarget: 'balanced',
    selectedSource: 'screen-1',
    backendOpen: false,
    backendUrl: 'https://api.wo.app',
  };

  function createStore(overrides = {}) {
    return { ...DEFAULT, ...overrides };
  }

  function initials(name) {
    if (!name) return 'WO';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function mark(size = 18) {
    return `<span class="mark" aria-hidden="true">${I().audioLines(size)}</span>`;
  }

  function themeSlot() {
    return '';
  }

  function refreshThemeSlots() {}

  function serverDialog(state) {
    if (!state.backendOpen) return '';
    return `
      <div class="modal-backdrop" data-action="close-backend" data-od-id="server-settings">
        <section class="modal server-modal" role="dialog" aria-modal="true" aria-labelledby="server-settings-title" data-action="noop">
          <header class="modal-header">
            <div>
              <h2 id="server-settings-title">服务器</h2>
              <p>填写规范的 HTTPS 服务地址</p>
            </div>
            <button class="icon-btn" type="button" data-action="close-backend" aria-label="关闭">${I().x(18)}</button>
          </header>
          <div class="modal-body">
            <label class="field"><span>HTTPS 服务地址</span>
              <input class="mono" data-bind="backendUrl" value="${escapeAttr(state.backendUrl)}" placeholder="https://api.example.com" autocomplete="url" spellcheck="false" /></label>
            <p class="meta" style="margin:0;font-size:12px;color:var(--muted);">用于切换自建或测试环境，不影响本原型交互。</p>
          </div>
          <footer class="modal-footer">
            <button class="btn btn-secondary" type="button" data-action="close-backend">取消</button>
            <button class="btn btn-primary" type="button" data-action="save-backend">保存</button>
          </footer>
        </section>
      </div>`;
  }

  function serverTrigger(state, opts = {}) {
    const compact = opts.compact === true;
    if (compact) {
      return `<button class="btn btn-ghost btn-sm" type="button" data-action="open-backend" style="color:var(--muted);" title="服务器">${I().settings(14)} 服务器</button>`;
    }
    return `
      <button class="server-trigger" type="button" data-action="open-backend" aria-label="配置服务器" data-od-id="server-trigger">
        <span class="server-trigger-icon" aria-hidden="true">${I().settings(16)}</span>
        <span class="server-trigger-copy">
          <span>服务器</span>
          <strong class="mono">${escapeHtml(state.backendUrl)}</strong>
        </span>
      </button>`;
  }

  function authView(state, opts = {}) {
    const heading =
      state.authMode === 'login'
        ? '登录 WO'
        : state.authMode === 'register'
          ? '创建 WO 账号'
          : '验证邮箱';
    const sub =
      state.authMode === 'verify'
        ? '输入邮箱中的 6 位验证码以完成注册'
        : '轻量语音与屏幕共享协作';

    return `
      <main class="auth-shell" data-od-id="auth-shell">
        <section class="auth-panel panel" aria-labelledby="auth-heading" data-od-id="auth-panel">
          <div class="product-lockup">${mark(16)}<span>WO</span></div>
          <h1 id="auth-heading">${heading}</h1>
          <p class="sub">${sub}</p>
          ${
            state.authMode !== 'verify'
              ? `<div class="segmented" role="tablist" aria-label="账号操作">
                  <button type="button" role="tab" class="${state.authMode === 'login' ? 'active' : ''}" data-action="auth-mode" data-mode="login" aria-selected="${state.authMode === 'login'}">登录账号</button>
                  <button type="button" role="tab" class="${state.authMode === 'register' ? 'active' : ''}" data-action="auth-mode" data-mode="register" aria-selected="${state.authMode === 'register'}">注册账号</button>
                </div>`
              : ''
          }
          <form class="auth-form" data-action="auth-submit" novalidate>
            ${
              state.authMode === 'register'
                ? `<label class="field"><span>显示名称</span>
                    <input name="displayName" maxlength="100" autocomplete="name" value="${escapeAttr(state.displayName)}" data-bind="displayName" /></label>`
                : ''
            }
            ${
              state.authMode !== 'verify'
                ? `<label class="field"><span>邮箱</span>
                    <input type="email" name="email" maxlength="254" autocomplete="email" value="${escapeAttr(state.email)}" data-bind="email" /></label>
                   <label class="field"><span>密码</span>
                    <input type="password" name="password" maxlength="128" autocomplete="${state.authMode === 'login' ? 'current-password' : 'new-password'}" value="${escapeAttr(state.password)}" data-bind="password" placeholder="至少 10 个字符" /></label>`
                : `<p class="auth-hint">验证码已发送至 <strong>${escapeHtml(state.email || 'your@email.com')}</strong></p>
                   <label class="field"><span>验证码</span>
                    <input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="${escapeAttr(state.code)}" data-bind="code" placeholder="6 位数字" class="mono" style="letter-spacing:0.28em;text-align:center;font-size:20px;" /></label>`
            }
            <div class="form-message" role="alert" aria-live="polite">${escapeHtml(state.authError)}</div>
            <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
              ${state.busy ? '处理中…' : state.authMode === 'login' ? '登录' : state.authMode === 'register' ? '创建账号' : '完成验证'}
            </button>
            ${
              state.authMode === 'verify'
                ? `<button class="btn btn-secondary btn-block" type="button" data-action="resend-code">重新发送验证码</button>
                   <div class="auth-footer-link"><button type="button" data-action="auth-mode" data-mode="login">返回登录</button></div>`
                : ''
            }
          </form>
          ${serverTrigger(state)}
          ${opts.extraFooter || ''}
        </section>
        ${serverDialog(state)}
      </main>`;
  }

  function homeView(state) {
    return `
      <div class="home-shell" data-od-id="home-shell">
        <header class="app-header" data-od-id="home-header">
          <div class="product-lockup compact">${mark(14)}<span>WO</span></div>
          <div class="account-summary">
            <span>${escapeHtml(state.user?.displayName || '用户')}</span>
            <button class="btn btn-ghost btn-sm" type="button" data-action="security" title="账号安全">${I().shield(15)} 安全</button>
            <button class="icon-btn" type="button" data-action="logout" aria-label="退出登录" title="退出登录">${I().logout(18)}</button>
          </div>
        </header>
        <main class="home-content" data-od-id="home-content">
          <div class="home-heading">
            <p>语音与屏幕共享</p>
            <h1>开始通话</h1>
          </div>
          <div class="room-actions">
            <section class="room-action" aria-labelledby="create-room-title" data-od-id="create-room">
              <span class="action-icon" aria-hidden="true">${I().plus(20)}</span>
              <div>
                <h2 id="create-room-title">新房间</h2>
                <p>创建临时房间码，邀请对方加入</p>
              </div>
              <button class="btn btn-primary" type="button" data-action="create-room" ${state.busy ? 'disabled' : ''}>
                ${state.busy ? '正在创建' : '创建房间'}
              </button>
            </section>
            <section class="room-action" aria-labelledby="join-room-title" data-od-id="join-room">
              <span class="action-icon join" aria-hidden="true">${I().users(20)}</span>
              <div>
                <h2 id="join-room-title">加入房间</h2>
                <p>输入对方发来的 6 位房间码</p>
              </div>
              <form class="join-form" data-action="join-room">
                <label class="sr-only" for="room-code">房间码</label>
                <input id="room-code" class="room-code-input" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" maxlength="6" data-bind="joinCode" value="${escapeAttr(state.joinCode)}" />
                <button class="btn btn-secondary" type="submit" ${state.busy ? 'disabled' : ''}>加入房间</button>
              </form>
            </section>
          </div>
          <div class="home-error" role="alert" aria-live="polite">${escapeHtml(state.homeError)}</div>
          <div class="home-meta">
            <span class="badge">${I().shield(12)} 端到端房间会话</span>
            <span class="badge">临时房间 · 关闭即失效</span>
            ${serverTrigger(state, { compact: true })}
          </div>
          ${serverDialog(state)}
        </main>
      </div>`;
  }

  function roomView(state, opts = {}) {
    const sharing = state.screen === 'sharing';
    const picking = state.screen === 'picking';
    const webUrl = `https://wo.app/join/${state.roomCode || '482913'}`;
    const clientUrl = `wo://join/${state.roomCode || '482913'}`;
    const participants = [
      { name: state.user?.displayName || '我', self: true, state: state.muted ? '已静音' : '语音已连接' },
      { name: '林可', self: false, state: '语音已连接' },
    ];

    return `
      <div class="room-shell" data-od-id="room-shell">
        <header class="room-header" data-od-id="room-header">
          <div class="product-lockup compact on-dark">${mark(13)}<span>WO</span></div>
          <div class="room-identity">
            <span class="status-pill ${state.connection}"><span class="dot"></span>${
              state.connection === 'connected'
                ? '已连接'
                : state.connection === 'connecting'
                  ? '连接中'
                  : state.connection === 'reconnecting'
                    ? '重连中'
                    : '连接失败'
            }</span>
            <span class="quality-panel" title="通话质量"><strong>${state.quality.rtt}</strong>ms · ${state.quality.loss}% · ${state.quality.bitrate} Mbps</span>
            <span class="room-code-label">房间码</span>
            <code class="mono">${escapeHtml(state.roomCode || '482913')}</code>
            <div style="position:relative;">
              <button class="icon-btn on-dark" type="button" data-action="toggle-share" aria-label="分享房间" aria-expanded="${state.shareMenu}">${I().share(16)}</button>
              ${
                state.shareMenu
                  ? `<div class="share-menu" data-od-id="share-menu">
                      <div class="url">${escapeHtml(webUrl)}</div>
                      <button type="button" data-action="copy" data-kind="web">${I().copy()} ${state.copied === 'web' ? '已复制网页链接' : '复制网页链接'}</button>
                      <div class="url">${escapeHtml(clientUrl)}</div>
                      <button type="button" data-action="copy" data-kind="client">${I().copy()} ${state.copied === 'client' ? '已复制客户端链接' : '复制客户端链接'}</button>
                    </div>`
                  : ''
              }
            </div>
          </div>
        </header>

        <main class="call-workspace ${sharing ? 'screen-live' : ''}" data-od-id="call-workspace">
          <div class="participants" aria-label="参与者">
            ${participants
              .map(
                (p) => `
              <div class="participant ${p.self && state.muted ? 'muted' : ''}" data-od-id="participant-${p.self ? 'self' : 'remote'}">
                <div class="avatar">${escapeHtml(initials(p.name))}</div>
                <div class="meta">
                  <span class="name">${escapeHtml(p.name)}${p.self ? '（我）' : ''}</span>
                  <span class="state">${escapeHtml(p.state)}</span>
                </div>
              </div>`
              )
              .join('')}
          </div>

          <section class="screen-stage ${sharing ? 'live' : ''}" data-od-id="screen-stage" aria-label="屏幕共享舞台">
            ${
              sharing
                ? `<div class="stage-canvas">
                    <div class="stage-badge"><span class="dot" style="background:var(--danger)"></span> 你正在共享 · 内建浏览器</div>
                    <div class="fake-ui" aria-hidden="true">
                      <div class="fake-bar"><span class="fake-dot"></span><span class="fake-dot"></span><span class="fake-dot"></span></div>
                      <div class="fake-body">
                        <div class="fake-side">
                          <div class="line w80"></div><div class="line w60"></div><div class="line w40"></div>
                          <div class="block"></div>
                        </div>
                        <div class="fake-main">
                          <div class="line w60"></div><div class="line w80"></div><div class="line w40"></div>
                          <div class="block"></div>
                        </div>
                      </div>
                    </div>
                    <div class="stage-controls">
                      <button type="button" data-action="noop">${I().expand()} 适应</button>
                    </div>
                  </div>
                  <div class="share-toolbar" data-od-id="share-toolbar">
                    <button class="chip ${state.bitrateTarget === 'saver' ? 'active' : ''}" type="button" data-action="bitrate" data-target="saver">省流</button>
                    <button class="chip ${state.bitrateTarget === 'balanced' ? 'active' : ''}" type="button" data-action="bitrate" data-target="balanced">均衡</button>
                    <button class="chip ${state.bitrateTarget === 'quality' ? 'active' : ''}" type="button" data-action="bitrate" data-target="quality">高清</button>
                    <button class="chip" type="button" data-action="stop-share" style="color:var(--danger);">停止共享</button>
                  </div>`
                : `<div class="stage-idle">
                    <div class="icon-ring">${I().monitorUp(28)}</div>
                    <h2>屏幕共享舞台</h2>
                    <p>开始共享后，画面将占据主舞台。语音继续在后台保持。</p>
                    <div style="margin-top:18px;">
                      <button class="btn btn-primary btn-pill" type="button" data-action="start-share">共享屏幕</button>
                    </div>
                  </div>`
            }
          </section>
        </main>

        ${
          picking
            ? `<div class="modal-backdrop" data-od-id="source-picker">
                <section class="modal" role="dialog" aria-modal="true" aria-labelledby="source-picker-title">
                  <header class="modal-header">
                    <div>
                      <h2 id="source-picker-title">选择共享内容</h2>
                      <p>屏幕或应用窗口</p>
                    </div>
                    <button class="icon-btn" type="button" data-action="cancel-share" aria-label="取消共享">${I().x(18)}</button>
                  </header>
                  <div class="modal-body">
                    <div class="source-grid" aria-label="可共享内容">
                      ${[
                        { id: 'screen-1', name: '内建视网膜显示器', kind: '屏幕', cls: 'screen' },
                        { id: 'win-1', name: 'Figma — WO Room', kind: '窗口', cls: '' },
                        { id: 'win-2', name: 'Safari — 文档', kind: '窗口', cls: '' },
                      ]
                        .map(
                          (s) => `
                        <button class="source-tile ${state.selectedSource === s.id ? 'selected' : ''}" type="button" data-action="select-source" data-source="${s.id}" aria-pressed="${state.selectedSource === s.id}">
                          <span class="source-thumb ${s.cls}">${s.kind === '屏幕' ? I().monitor(22) : 'App'}</span>
                          <span class="source-meta"><strong>${escapeHtml(s.name)}</strong><span>${s.kind}</span></span>
                        </button>`
                        )
                        .join('')}
                    </div>
                  </div>
                  <footer class="modal-footer">
                    <button class="btn btn-secondary" type="button" data-action="cancel-share">取消</button>
                    <button class="btn btn-primary" type="button" data-action="confirm-share">开始共享</button>
                  </footer>
                </section>
              </div>`
            : ''
        }

        <div class="toolbar-wrap" data-od-id="call-toolbar">
          <div class="call-toolbar" role="toolbar" aria-label="通话控制">
            <button class="tool-btn ${state.muted ? 'muted' : ''}" type="button" data-action="toggle-mute" aria-label="${state.muted ? '取消静音' : '静音'}" title="${state.muted ? '取消静音' : '静音'}">
              ${state.muted ? I().micOff(20) : I().mic(20)}
            </button>
            <button class="tool-btn ${state.outputMuted ? 'muted' : ''}" type="button" data-action="toggle-output" aria-label="${state.outputMuted ? '取消扬声器静音' : '扬声器静音'}" title="扬声器">
              ${I().volume(20)}
            </button>
            <button class="tool-btn ${sharing || picking ? 'active' : ''}" type="button" data-action="${sharing ? 'stop-share' : 'start-share'}" aria-label="${sharing ? '停止共享' : '共享屏幕'}" title="${sharing ? '停止共享' : '共享屏幕'}">
              ${I().monitorUp(20)}
            </button>
            <button class="tool-btn" type="button" data-action="settings" aria-label="通话设置" title="设置">${I().settings(20)}</button>
            <button class="tool-btn hangup" type="button" data-action="hangup" aria-label="挂断" title="挂断">${I().phoneOff(20)}</button>
          </div>
        </div>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("'", '&#39;');
  }

  function handleAction(state, action, dataset, value) {
    const next = { ...state };
    switch (action) {
      case 'auth-mode':
        next.authMode = dataset.mode;
        next.authError = '';
        break;
      case 'auth-submit': {
        if (next.authMode === 'verify') {
          if (!/^\d{6}$/.test(next.code.trim())) {
            next.authError = '请输入 6 位数字验证码';
            break;
          }
          next.user = { displayName: next.displayName || '用户', email: next.email };
          next.route = 'home';
          next.authError = '';
          break;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email.trim())) {
          next.authError = '请输入有效的邮箱地址';
          break;
        }
        if ((next.password || '').length < 10) {
          next.authError = '密码需为 10 到 128 个字符';
          break;
        }
        if (next.authMode === 'register') {
          if (!next.displayName.trim()) {
            next.authError = '请输入显示名称';
            break;
          }
          next.authMode = 'verify';
          next.authError = '';
          next.code = '';
          break;
        }
        next.user = { displayName: next.displayName || next.email.split('@')[0], email: next.email };
        next.route = 'home';
        next.authError = '';
        break;
      }
      case 'resend-code':
        next.authError = '';
        break;
      case 'logout':
        next.route = 'auth';
        next.authMode = 'login';
        next.user = null;
        next.password = '';
        next.roomCode = '';
        next.screen = 'idle';
        break;
      case 'create-room':
        next.roomCode = String(Math.floor(100000 + Math.random() * 900000));
        next.route = 'room';
        next.connection = 'connected';
        next.screen = 'idle';
        next.shareMenu = false;
        next.homeError = '';
        break;
      case 'join-room':
        if (!/^\d{6}$/.test(next.joinCode)) {
          next.homeError = '请输入 6 位房间码';
          break;
        }
        next.roomCode = next.joinCode;
        next.route = 'room';
        next.connection = 'connected';
        next.screen = 'idle';
        next.shareMenu = false;
        next.homeError = '';
        break;
      case 'hangup':
        next.route = 'home';
        next.screen = 'idle';
        next.shareMenu = false;
        next.muted = false;
        break;
      case 'toggle-mute':
        next.muted = !next.muted;
        break;
      case 'toggle-output':
        next.outputMuted = !next.outputMuted;
        break;
      case 'start-share':
        next.screen = 'picking';
        next.shareMenu = false;
        break;
      case 'cancel-share':
        next.screen = 'idle';
        break;
      case 'select-source':
        next.selectedSource = dataset.source;
        break;
      case 'confirm-share':
        next.screen = 'sharing';
        next.quality = { ...next.quality, bitrate: next.bitrateTarget === 'quality' ? 4.8 : next.bitrateTarget === 'saver' ? 1.2 : 2.4 };
        break;
      case 'stop-share':
        next.screen = 'idle';
        break;
      case 'bitrate':
        next.bitrateTarget = dataset.target;
        next.quality = {
          ...next.quality,
          bitrate: dataset.target === 'quality' ? 4.8 : dataset.target === 'saver' ? 1.2 : 2.4,
        };
        break;
      case 'toggle-share':
        next.shareMenu = !next.shareMenu;
        next.copied = null;
        break;
      case 'copy':
        next.copied = dataset.kind;
        if (navigator.clipboard) {
          const code = next.roomCode || '482913';
          const text = dataset.kind === 'web' ? `https://wo.app/join/${code}` : `wo://join/${code}`;
          navigator.clipboard.writeText(text).catch(() => {});
        }
        break;
      case 'open-backend':
        next.backendOpen = true;
        break;
      case 'close-backend':
      case 'save-backend':
        next.backendOpen = false;
        break;
      case 'toggle-backend':
        next.backendOpen = !next.backendOpen;
        break;
      case 'noop':
        break;
      case 'security':
        next.homeError = '账号安全：已启用邮箱验证与安全会话。';
        break;
      case 'settings':
        break;
      case 'goto':
        next.route = dataset.route;
        break;
      case 'bind':
        if (dataset.bind) next[dataset.bind] = value;
        if (dataset.bind === 'joinCode') next.joinCode = String(value).replace(/\D/g, '').slice(0, 6);
        if (dataset.bind === 'code') next.code = String(value).replace(/\D/g, '').slice(0, 6);
        break;
      default:
        break;
    }
    return next;
  }

  const THEME_ACTIONS = new Set(['set-theme', 'cycle-theme']);

  function mount(root, initial, renderShell) {
    let state = createStore(initial);
    const render = () => {
      root.innerHTML = renderShell(state);
      refreshThemeSlots(root);
    };

    root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) {
        if (!event.target.closest('.share-menu') && state.shareMenu) {
          state = { ...state, shareMenu: false };
          render();
        }
        return;
      }
      const action = target.getAttribute('data-action');
      // Theme actions are owned by WOTheme — don't re-render away from them.
      if (THEME_ACTIONS.has(action)) return;
      // Backdrop closes; clicks inside modal body must not bubble as close.
      if (action === 'close-backend' && target.classList.contains('modal-backdrop')) {
        if (event.target !== target) return;
      }
      if (action === 'noop') {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      state = handleAction(state, action, target.dataset, null);
      render();
    });

    root.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-action]');
      if (!form) return;
      event.preventDefault();
      const action = form.getAttribute('data-action');
      state = handleAction(state, action, form.dataset, null);
      render();
    });

    root.addEventListener('input', (event) => {
      const el = event.target;
      if (!el.dataset.bind) return;
      state = handleAction(state, 'bind', el.dataset, el.value);
      // keep focus: only re-render when needed for join code formatting
      if (el.dataset.bind === 'joinCode' || el.dataset.bind === 'code') {
        const pos = el.selectionStart;
        render();
        const again = root.querySelector(`[data-bind="${el.dataset.bind}"]`);
        if (again) {
          again.focus();
          try { again.setSelectionRange(pos, pos); } catch {}
        }
      } else {
        state[el.dataset.bind] = el.value;
      }
    });

    render();
    return {
      getState: () => state,
      setState: (partial) => {
        state = { ...state, ...partial };
        render();
      },
    };
  }

  window.WOApp = {
    createStore,
    authView,
    homeView,
    roomView,
    handleAction,
    mount,
    mark,
    themeSlot,
    refreshThemeSlots,
  };
})();
