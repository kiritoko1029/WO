# WO

**English** | [简体中文](README.zh-CN.md)

WO is a self-hostable two-person voice and desktop-sharing application. In
server mode, your own Docker Compose stack provides accounts, room signaling,
the web client, PostgreSQL, and TURN, while media flows directly between the
two peers whenever the network allows. The desktop app additionally offers a
lightweight room mode restricted to trusted local networks.

> Current capabilities are covered by automated tests, but official
> Windows/macOS installers, real two-device LAN validation, and 1080p60 have
> not yet completed release certification. For the exact status see the
> [support matrix](docs/support-matrix.md).

## Repository layout

| Path                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `apps/desktop`          | Electron desktop client                                     |
| `apps/web`              | Browser client reusing the desktop React/WebRTC layers      |
| `apps/server`           | Central API, room signaling, and the embeddable LAN service |
| `packages/protocol`     | Shared runtime protocol for REST, signaling, invites, WebRTC |
| `packages/database`     | PostgreSQL schema and migrations                            |
| `packages/config`       | Central service configuration                               |
| `packages/media-policy` | Media parameters and policies                               |
| `deploy`                | Compose deployment for Caddy, server, PostgreSQL, and coturn |
| `apps/media-lab-*`      | Media capability experiments, not part of the product entry |

## Server-mode quick start

Requires Node.js 24, pnpm 10.32.1, Linux x86_64, Docker Engine 26+, and
Docker Compose 2.24.4+.

```bash
pnpm install --frozen-lockfile
cp deploy/.env.example deploy/.env
node deploy/scripts/init-secrets.mjs
```

Edit `deploy/.env` to set real domains, certificates, and a public IPv4 for
the app and TURN, then run:

```bash
node deploy/scripts/preflight.mjs --env-file=deploy/.env
node deploy/scripts/compose.mjs --env-file=deploy/.env up -d --build --wait
node deploy/scripts/smoke.mjs --env-file=deploy/.env
```

Open `https://<APP_DOMAIN>` to use the web client. Caddy serves the SPA and
proxies `/v1/*` and the realtime WebSocket on a single HTTPS origin, so no
separate web domain or CORS setup is needed. Full requirements for
certificates, firewalling, backups, and upgrades are in the
[deployment guide](docs/deployment.md).

## Connecting the desktop app to your server

The desktop client shows a "Server" field on both the login page and the home
screen. The value must be a canonical HTTPS origin:

```text
https://wo.example.com
```

No path, query, fragment, username, or password is allowed. After saving, the
client restarts so that REST, WSS, CSP, and sessions all switch to the same
origin.

Backend resolution order:

```text
WO_API_ORIGIN > desktop user configuration > https://localhost
```

For example, an operator can pin the address:

```bash
WO_API_ORIGIN=https://wo.example.com pnpm --filter @wo/desktop dev
```

When `WO_API_ORIGIN` is set, the field becomes read-only. Refresh tokens are
bound to the origin, so switching servers never sends old credentials to the
new server. Self-signed certificates are only for isolated testing; import the
public CA certificate into the system trust store properly instead of
disabling TLS verification.

## Joining and sharing rooms

Server rooms can be shared as a 6-digit room code, or as either of two link
forms:

```text
https://wo.example.com/join/123456
wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456
```

The HTTPS link keeps using the same-origin web client, or can wake the
installed desktop client via the "Open in WO client" button on the page. When
an invite points at a different server, the desktop client shows the target
domain and asks for confirmation; after confirming it restarts and signs in
again on the target server — it never switches silently or reuses the previous
session.

Do not hand-assemble `wo://` links. The client strictly validates the protocol
version, server origin, room code, and LAN invite fields.

## Trusted-LAN lite mode

Lite mode is only for two desktop devices on the same trusted RFC1918
network:

1. The host selects "Trusted LAN" on the login or home screen, enters a
   display name, and creates a room.
2. The host copies the "client invite link" from the room and sends it to the
   other device privately.
3. The joiner opens the link; alternatively they can select "Trusted LAN" →
   "Join room", enter a display name, and paste the full `wo://` invite.

- The room creator runs a temporary two-person service inside the desktop
  process.
- No central server, accounts, PostgreSQL, or TURN required.
- The room ends when the host quits, the device sleeps, or the service stops;
  a vanished bound address or changed network identity is detected by the
  default 5-second polling and shuts the room down.
- The 6-digit code is only for human verification: it cannot discover the host
  on its own and is not an authentication credential.
- The full invite additionally carries the host's private address, a random
  port, and a 256-bit random key.
- Signaling frames are HMAC-SHA-256 authenticated with replay rejection, but
  the `ws://`/`http://` transport itself is not encrypted.

Therefore do not use lite mode on guest Wi-Fi, public networks, or untrusted
corporate segments. Knowing the room code alone still does not let anyone find
or join the room; the full invite shared by the creator is required. The full
invite is equivalent to a temporary access credential — never post it to
public channels or logs.

This mode has protocol, service, and automated integration evidence, but has
not yet passed voice, screen-share, and firewall certification on two real
Windows/macOS devices; its status is `IMPLEMENTED, NOT CERTIFIED`.

## Web support boundary

The first web release targets current desktop Chrome and Edge and always uses
the page's own same-origin backend. The refresh token is kept only in the
tab's `sessionStorage`, so closing the tab requires signing in again. Screen
sharing uses the browser's native picker; when `getDisplayMedia()` is
unavailable it degrades to voice-only. Safari, Firefox, and mobile browsers
are outside the current screen-sharing commitment.

## Development checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:contract
pnpm test:e2e:web
```

Web E2E boots and tears down an isolated four-service Compose stack using
`deploy/.env.integration`, verifying create, join, and bidirectional voice
with two Chromium sessions.

Development and packaging commands for desktop/web live in
[`apps/desktop/package.json`](apps/desktop/package.json) and
[`apps/web/package.json`](apps/web/package.json).

## License

Released under the [MIT License](LICENSE).
