# UI preview and screenshots

The preview renders WO's actual shared React `App`, routes, dialogs, and CSS.
It injects deterministic local implementations of `DesktopApi`, `RoomGateway`,
and `CallController`, using the same dependency boundaries as the component
tests. No backend, real account, microphone, desktop capture, or external
service is used. Example names, email addresses, room state, and connection
indicators are fixtures, not a real call.

## Run

Install the repository dependencies with Node.js 24 and pnpm 10.32.1, then run:

```bash
pnpm --filter @wo/web dev --host 127.0.0.1
```

Open `http://127.0.0.1:5173/preview/index.html`. The preview navigation switches
between login, home, and room scenes. Mute, volume, dialogs, and theme controls
operate on local state. Server changes and media capture are intentionally
unavailable. Use the real client and integration environment for those tests.

The `preview/` HTML is not included in the explicit production inputs in
`apps/web/vite.config.ts`. `pnpm --filter @wo/web typecheck` also checks the
preview TypeScript so fixture interfaces stay aligned with the application.

## Reproduce the README images

Use a 1280 × 800 desktop viewport at 100% browser zoom. The captured scenes are:

| File                              | Local preview path                                   |
| --------------------------------- | ---------------------------------------------------- |
| `docs/screenshots/auth-light.jpg` | `/preview/index.html?scene=auth&theme=light&capture` |
| `docs/screenshots/home-light.jpg` | `/preview/index.html?scene=home&theme=light&capture` |
| `docs/screenshots/room-dark.jpg`  | `/preview/index.html?scene=room&theme=dark&capture`  |

Wait for the page to finish restoring its local session, then capture the
viewport with your browser's screenshot tool. The `capture` flag hides only
the preview navigation; the **本地演示 · 示例数据** label remains visible.
The theme query updates the preview origin's theme preference. The room
screenshot shows a simulated connected call waiting for screen sharing.

Also inspect 390 × 844 and 960 × 540 layouts: primary actions must remain
reachable by scrolling, modal content must fit or scroll, Tab must stay inside
an open modal, and Escape must restore focus to its trigger when dismissal is
allowed. Check both themes. Do not use these screenshots as evidence for
two-device capture, codec support, 1080p60, or release certification.
