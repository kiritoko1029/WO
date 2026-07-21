/* WO theme controller: light | dark | system — single corner button */
(function () {
  const STORAGE_KEY = 'wo-theme';
  const MODES = ['system', 'light', 'dark'];
  const listeners = new Set();
  let media = null;
  let cornerEl = null;

  function normalize(mode) {
    return MODES.includes(mode) ? mode : 'system';
  }

  function getPreference() {
    try {
      return normalize(localStorage.getItem(STORAGE_KEY) || 'system');
    } catch {
      return 'system';
    }
  }

  function systemPrefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolve(mode = getPreference()) {
    const pref = normalize(mode);
    if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
    return pref;
  }

  function apply(mode = getPreference()) {
    const pref = normalize(mode);
    const resolved = resolve(pref);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themePref = pref;
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = pref === 'system' ? 'light dark' : resolved;
    refreshCorner();
    listeners.forEach((fn) => {
      try { fn({ preference: pref, resolved }); } catch {}
    });
    return { preference: pref, resolved };
  }

  function setPreference(mode) {
    const pref = normalize(mode);
    try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
    return apply(pref);
  }

  function cycle() {
    const order = ['system', 'light', 'dark'];
    const current = getPreference();
    const next = order[(order.indexOf(current) + 1) % order.length];
    return setPreference(next);
  }

  function label(mode = getPreference()) {
    return { system: '自适应', light: '浅色', dark: '深色' }[normalize(mode)];
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function bindMedia() {
    if (media) return;
    media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getPreference() === 'system') apply('system');
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if (typeof media.addListener === 'function') media.addListener(onChange);
  }

  function iconFor(pref) {
    const I = window.WOIcons || {};
    const fn =
      pref === 'system' ? I.sunMoon : pref === 'dark' ? I.moon : I.sun;
    return typeof fn === 'function' ? fn(16) : '';
  }

  function controlHtml() {
    const pref = getPreference();
    const resolved = resolve(pref);
    return `
      <button type="button" class="theme-fab" data-action="cycle-theme"
        aria-label="切换主题，当前：${label(pref)}（生效 ${resolved === 'dark' ? '深色' : '浅色'}）"
        title="主题：${label(pref)} · 点击切换">
        ${iconFor(pref)}
      </button>`;
  }

  function refreshCorner() {
    if (!cornerEl) return;
    cornerEl.innerHTML = controlHtml();
  }

  /**
   * Mount one corner theme button.
   * @param {{ host?: Element|string }} [opts]
   *   host — container with position:relative (e.g. desktop .window);
   *   omit for fixed viewport corner on web pages.
   */
  function mountCorner(opts = {}) {
    const host =
      typeof opts.host === 'string'
        ? document.querySelector(opts.host)
        : opts.host || document.body;
    if (!host) return null;

    let wrap = host.querySelector(':scope > .theme-fab-host');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'theme-fab-host' + (opts.host ? ' theme-fab-host--contained' : ' theme-fab-host--fixed');
      wrap.setAttribute('data-od-id', 'theme-fab');
      host.appendChild(wrap);
    }
    cornerEl = wrap;
    refreshCorner();

    if (!wrap.dataset.wired) {
      wrap.dataset.wired = '1';
      wrap.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action="cycle-theme"]');
        if (!btn) return;
        event.preventDefault();
        cycle();
      });
    }
    return wrap;
  }

  // Back-compat aliases used by older page scripts
  function wireDocument() {
    mountCorner();
  }

  apply(getPreference());
  bindMedia();

  window.WOTheme = {
    STORAGE_KEY,
    getPreference,
    setPreference,
    cycle,
    resolve,
    apply,
    label,
    controlHtml,
    mountCorner,
    subscribe,
    wireDocument,
  };
})();
