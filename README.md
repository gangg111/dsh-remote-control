### dsh-remote-control

Remote control for DeepSeek Harness (the desktop app or `dsh web`) from your phone over Tailscale.
On the phone, the **Code** screen of the `dsh-code` plugin in
[DeepSeek-Harness-Mobile](https://github.com/gangg111/DeepSeek-Harness-Mobile) lists the computer's
sessions: tapping one opens it with full history, attachments, model selection and a stop button.

### How it works

```
phone -> Tailscale (HTTPS) -> dsh-tsnet.exe -> gateway 127.0.0.1:19390 -> DSH 127.0.0.1:19387
                              (node dsh-pc,    (this plugin)
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

### Session transfer (phone and computer)

`info` advertises `capabilities: ["session-transfer"]` and `sessionFormat: 4`.

- **PC to phone:** every session row in the DSH sidebar gets an "Export to phone" icon
  (`sidebar.workspaces.session.row.action`). It queues the session in an outbox
  (`~/.dsh/remote-control-outbox.json`); the icon then shows "waiting for the phone", and
  "received" after the phone confirms. The phone polls:
  - `GET /__remote/api/outbox` returns the waiting entries `{transferId, sessionId, title, createdAt}`;
  - `GET /__remote/api/outbox/<transferId>` streams the native DSH export ZIP of that session;
  - `GET /__remote/api/outbox/<transferId>/files` returns the project files the agent changed in that
    session, as a separate small ZIP (`manifest.json` + `tree/<relative path>`), so the session log and
    media keep streaming untouched (capability `workspace-files`, see below);
  - `DELETE /__remote/api/outbox/<transferId>` confirms a successful import (until then the entry stays).
- **Phone to PC:** `POST /__remote/api/sessions/import` with the native export ZIP as the body
  (limit 256 MB, optional `?workspaceId=`) returns `{sessionId, title, events, attachments}`.
- **Import** (`lib/transfer.js`) creates a new session (new id, the original stays on the sender) in the
  default workspace through `sessionPersistence`, re-saves images and files through `attachments`
  and rewrites their references, rebinds log-delivery markers to the new id, then reads the session
  back: if this DSH refuses it, the stored copy is removed and the request fails with 422. The title
  is restored through the official rename, which also makes the session appear in the list at once.
  Logs of subagents are not transferred; their results are already part of the main log.
  A forked session is imported as a fork (inherited part kept, no parent), and a session whose model
  this device lacks is switched to this device's default model (`modelChanged` in the result).

### Project files with a session (phase 1)

So the receiving agent continues on the same files instead of starting over, an export can carry the
project files alongside the session. `info` advertises `capabilities: ["workspace-files"]`.

- **Shared module** (`lib/workspace-files.js`, the phone vendors an unchanged copy): `agentEditedPaths`
  reads the paths the agent changed through `edit` / `write` / `apply_patch`; `collectFiles` hashes them
  (sha256), applies the exclusions and size limits, and builds `manifest.json`; `applyWorkspaceZip`
  writes the files on the other side (atomic temp + rename), keeping an older differing file beside the
  new one as a conflict copy so nothing is lost; `diffAgainstBase` lists changed, new and deleted files
  against a base manifest (phase 2, the return trip); `safeRelSegments` rejects absolute paths, `..`,
  drive letters and Windows reserved names.
- **Phase 1 scope** is `agent`: only files the agent changed through its tools, inside the session's
  `cwd`. The whole-project scope and the return trip (diff against the manifest) are phase 2.
- **Exclusions** (both directions): build and dependency directories (`.git`, `node_modules`, `bin`,
  `obj`, `build`, `dist`, `target`, `.venv`, …) and files that are useless on the other side or
  sensitive (`.exe`, `.dll`, `.pfx`, `.key`, `.pem`, `.env`, `.keystore`, …). Excluded files go on the
  manifest's `skipped` list with a reason, never dropped silently. Size and count limits apply.

### Session sync (linked copies)

`info` advertises `capabilities: ["session-sync"]`. A linked pair has one owner (writable) and one
read-only mirror; the gateway on the PC keeps the link state (`~/.dsh/remote-control-links.json`) and the
phone is the courier.

- **Tails** (`lib/sync.js`): events after the other side's mark up to the last completed turn, as a ZIP
  (`tail.jsonl` + media). The mirror appends them through the live session (`Session.append`, which
  validates every event), never through the stored file. Every reference by event number is remapped
  through the link's number map; an unknown reference stops the sync with 409 instead of storing a
  wrong pointer. Log-delivery markers are not copied.
- **Routes** (`lib/link-api.js`): `GET/POST /__remote/api/links`, `GET /links/<id>/events` (PC tail),
  `POST /links/<id>/applied`, `POST /links/<id>/events` (phone tail), `POST /links/<id>/claim`,
  `POST /links/<id>/claim-confirm`, `POST /links/<id>/pause` (the phone's gate stopped an owner
  turn), `POST /links/<id>/resume`, `DELETE /links/<id>`; every write checks
  the link `epoch`.
- **Turn counter** (`reloadSession`, `guardTurnStart` in `lib/sync.js`): a DSH agent reads its turn
  counter from the log only when it is created, and `Session.append` does not move it, so after a takeover
  it would reuse a turn number that is already in the log (DSH then refuses to load the session). A plugin
  cannot dispose a live agent, so `reloadSession` sets the idle agent's counter to the last turn in the
  log after every appended tail and before the PC becomes the owner. A gate on `agent/status: running`
  (emitted before `turn/start` is written) stops any turn of a mirror, and any owner turn whose number is
  not the last logged turn + 1; the link is then paused (`paused` in the link, `POST /links/<id>/resume`).
  Both rely on agent internals, so sync is enabled only on DSH versions where the takeover test passed
  (`SYNC_TESTED_DSH` in `index.js`, currently 0.2.0-rc.2); on others the write routes return 503.
- **On the PC:** the session row icon shows "you write here" or "mirror of the phone"; a mirror has its
  composer blocked and a "Take over writing here" bar (the phone hands over after finishing its turn; after
  a minute the PC may take over without it). A paused link shows its reason and a "Resume sync" button.

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
