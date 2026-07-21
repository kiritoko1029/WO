# WO Product Prototype

High-fidelity interactive prototype for WO (voice + screen-share collaboration).

## Entry

Open `index.html` for the launcher, or jump directly:

| Surface | Path |
|---|---|
| Marketing landing | `web/landing.html` |
| Web app | `web/app.html` |
| Desktop app frame | `desktop/app.html` |
| Light admin | `web/admin.html` |

### Deep links

- Auth: `?start=auth`
- Home: `?start=home`
- Room idle: `?start=room&screen=idle`
- Room sharing: `?start=room&screen=sharing`
- Source picker: `?start=room&screen=picking`

## Shared system

- `shared/tokens.css` — Apple design-system bindings + light/dark tokens + stage tokens
- `shared/theme.js` — theme preference (`system` / `light` / `dark`), localStorage, OS sync
- `shared/app.css` — product chrome + theme controls
- `shared/app-core.js` — navigable state machine + screen renderers
- `shared/icons.js` — monoline SVG icons

## Theme

- One **corner button** (bottom-right): click cycles 自适应 → 浅色 → 深色
- Desktop: inside app window; Web: fixed on viewport
- Persist: `localStorage.wo-theme`

## Flows covered

1. Auth — 登录 / 注册 / 6 位邮箱验证 + 服务器设置
2. Home — 创建房间 / 加入房间 / 账号安全 / 退出
3. Room — 参与者、连接状态、质量面板、通话工具栏、屏幕舞台、源选择器、共享工具栏、加入链接复制
4. Landing — brand-first 中文营销页 → Web / Desktop
5. Admin — secondary ops surface (does not compete with product)

## Implementation mapping

Desktop `AuthRoute` / `HomeRoute` / `RoomRoute` + components (`CallToolbar`, `ScreenStage`, `SourcePicker`, `QualityPanel`, …) map 1:1 onto the prototype screens for the Electron + Vite React apps.
