### dsh-remote-control

Remote control for DeepSeek Harness (the desktop app or `dsh web`) from your phone over Tailscale.
On the phone, the **Code** screen of the `dsh-code` plugin in
[DeepSeek-Harness-Mobile](https://github.com/gangg111/DeepSeek-Harness-Mobile) lists the computer's
sessions: tapping one opens it with full history, attachments, model selection and a stop button.

### How it works

```
phone ── Tailscale (HTTPS) ──> dsh-tsnet.exe ──> gateway 127.0.0.1:19390 ──> DSH 127.0.0.1:19387
                               (node dsh-pc,      (this plugin)
                                WhoIs = account)
```

- **`embedded` mode (default on Windows):** the plugin runs `bin/dsh-tsnet.exe`, an embedded Tailscale
  node (the `tsnet` library). No Tailscale install, no system VPN and no administrator rights are
  needed. The node joins your tailnet as `dsh-pc` and serves HTTPS with a Tailscale certificate.
- **`system` mode:** uses an installed Tailscale and `tailscale serve --https=443` (configured
  automatically, never `funnel`).
- In `embedded` mode the caller's identity comes from `WhoIs` on the Tailscale connection and reaches
  the gateway together with a secret generated on every start. Any local process that does not know
  the secret gets 403.
- Only the node owner (or the `allowedLogins` list) is let in.
- Cross-site requests (`sec-fetch-site: cross-site`, foreign `Origin`) are rejected before the gateway
  rewrites anything. Only then are `Host`/`Origin` rewritten to loopback, so the DSH DNS-rebinding
  fence keeps working unchanged.
- DSH login: the gateway exchanges the launch token for a session cookie on the computer side
  (the official `ctx.connection.authenticatedUrl`). The token never reaches the phone, and the cookie
  gets `Secure`.
- The phone API (`/__remote/api/info`, `sessions`, `workspaces`, `POST sessions`) sits behind the
  same checks. `info` returns `service: "dsh-remote-control"`, which the phone uses to discover the
  computer automatically.
- The browser part opens the session given in `?dshOpen=<id>` (`ctx.uiWorkspace.openSession`).

### Installation

1. In DSH on the computer: Plugins, Add plugin from GitHub: `gangg111/dsh-remote-control`.
2. On first start a browser opens the Tailscale login page. Sign in with the same account as on the
   phone and approve the `dsh-pc` device. The link is also in `~/.dsh/remote-control.json`
   (`loginURL`). Login is one-time: the node state stays in `~/.dsh/remote-control/tsnet`.
3. In the Tailscale admin console (https://login.tailscale.com/admin/dns) enable MagicDNS and
   HTTPS Certificates.
4. On the phone the Code screen finds the computer in the tailnet by itself. Manually: Add device and
   enter the address from `url` in `~/.dsh/remote-control.json` (e.g. `dsh-pc.tail1234.ts.net`).

### Settings (the `remote-control` row in the profile's `cordis.patch.yml`)

| Field | Default | Meaning |
|---|---|---|
| `mode` | `embedded` on Windows with `bin/dsh-tsnet.exe`, otherwise `system` | How the gateway is exposed |
| `hostname` | `dsh-pc` | Device name in the tailnet (`embedded` mode) |
| `port` | `19390` | Gateway port on 127.0.0.1 |
| `allowedLogins` | `[]` | Tailscale accounts with access; empty list = node owner only |
| `openBrowser` | `true` | Whether to open the browser with the login link |
| `httpsPort` | `443` | HTTPS port for `tailscale serve` (`system` mode) |
| `manageServe` | `true` | Whether to configure `tailscale serve` (`system` mode) |

### Troubleshooting

`~/.dsh/remote-control.json`: `mode`, `backendState` (`NeedsLogin`, `Running`), `loginURL`, `url`,
`owner`, `cert`, `error`.

- `NeedsLogin`: open `loginURL` and sign in.
- `cert.ok: false` or a TLS error on the phone: enable HTTPS Certificates in the Tailscale admin console.
- 403 for your account: the phone is signed in to a different Tailscale account than the computer.
- Event log of the embedded node: `~/.dsh/remote-control/dsh-tsnet.log`.

### Building dsh-tsnet.exe

Source in `tsnet/` (Go, `tailscale.com` pinned in `go.mod`). After updating Tailscale:

```
cd tsnet
go get tailscale.com@latest && go mod tidy
go build -trimpath -ldflags "-s -w -H windowsgui" -o ..\bin\dsh-tsnet.exe .
```

`-H windowsgui` (GUI subsystem) keeps the process started by DSH from opening a console window.

### Tests

`node --test`: gateway (identity, secret, CSRF, login, WebSocket), API, dsh-tsnet supervision and
Tailscale CLI parsing. A fake DSH server reproduces the behaviour of 0.1.7-rc.2.

### License

MIT (see `LICENSE`). `bin/dsh-tsnet.exe` includes Tailscale (BSD-3-Clause) and Go (BSD-3-Clause),
see `THIRD_PARTY_NOTICES.md`.
