### dsh-remote-control

Zdalne sterowanie DeepSeek Harness (aplikacja desktopowa albo `dsh web`) z telefonu przez Tailscale.
Na telefonie sesje komputera pokazuje ekran **Code** z wtyczki `dsh-code` (apka DeepSeek-Harness-Mobile):
dotknięcie sesji otwiera ją z pełną historią, załącznikami, wyborem modelu i zatrzymywaniem.

### Jak to działa

```
telefon ── Tailscale (HTTPS) ──> dsh-tsnet.exe ──> brama 127.0.0.1:19390 ──> DSH 127.0.0.1:19387
                                 (węzeł dsh-pc,     (ta wtyczka)
                                  WhoIs = konto)
```

- **Tryb `embedded` (domyślny na Windows):** wtyczka uruchamia `bin/dsh-tsnet.exe`, wbudowany węzeł
  Tailscale (biblioteka `tsnet`). Nie trzeba instalować Tailscale, nie jest zajmowany systemowy VPN
  i nie są potrzebne uprawnienia administratora. Węzeł dołącza do Twojej sieci jako `dsh-pc` i sam
  wystawia HTTPS z certyfikatem Tailscale.
- **Tryb `system`:** zainstalowany Tailscale i `tailscale serve --https=443` (ustawiane automatycznie,
  nigdy `funnel`).
- Tożsamość wywołującego w trybie `embedded` pochodzi z `WhoIs` połączenia Tailscale, a do bramy idzie
  z sekretem losowanym przy każdym starcie. Proces na tym komputerze, który nie zna sekretu, dostaje 403.
- Wpuszczany jest tylko właściciel węzła (albo lista `allowedLogins`).
- Żądania z obcych stron (`sec-fetch-site: cross-site`, obcy `Origin`) są odrzucane, zanim brama
  cokolwiek przepisze. Dopiero potem `Host`/`Origin` zmieniają się na adres pętli zwrotnej, więc zapora
  DSH przed DNS rebinding działa bez zmian.
- Logowanie do DSH: brama wymienia token startowy na ciasteczko sesji po stronie komputera
  (oficjalne `ctx.connection.authenticatedUrl`). Token nie trafia do telefonu, ciasteczko dostaje `Secure`.
- API dla telefonu (`/__remote/api/info`, `sessions`, `workspaces`, `POST sessions`) jest za tą samą kontrolą.
- Część przeglądarkowa otwiera sesję wskazaną w adresie `?dshOpen=<id>` (`ctx.uiWorkspace.openSession`).

### Instalacja

1. W DSH na komputerze: Pluginy, Dodaj plugin z GitHuba: `gangg111/dsh-remote-control`.
2. Przy pierwszym starcie otworzy się przeglądarka na stronie logowania Tailscale. Zaloguj się tym samym
   kontem co na telefonie i potwierdź urządzenie `dsh-pc`. Link jest też w `~/.dsh/remote-control.json`
   (pole `loginURL`). Logowanie jest jednorazowe: stan węzła zostaje w `~/.dsh/remote-control/tsnet`.
3. W panelu Tailscale (https://login.tailscale.com/admin/dns) włącz MagicDNS i HTTPS Certificates.
4. Na telefonie ekran Code sam znajdzie komputer w sieci Tailscale. Ręcznie: Dodaj urządzenie i adres
   z pola `url` w `~/.dsh/remote-control.json` (np. `dsh-pc.tail1234.ts.net`).

### Ustawienia (wiersz `remote-control` w `cordis.patch.yml` profilu)

| Pole | Domyślnie | Znaczenie |
|---|---|---|
| `mode` | `embedded` na Windows z `bin/dsh-tsnet.exe`, inaczej `system` | Sposób wystawienia bramy |
| `hostname` | `dsh-pc` | Nazwa urządzenia w sieci Tailscale (tryb `embedded`) |
| `port` | `19390` | Port bramy na 127.0.0.1 |
| `allowedLogins` | `[]` | Konta Tailscale z dostępem; pusta lista = tylko właściciel węzła |
| `openBrowser` | `true` | Czy otwierać przeglądarkę z linkiem logowania |
| `httpsPort` | `443` | Port HTTPS w `tailscale serve` (tryb `system`) |
| `manageServe` | `true` | Czy ustawiać `tailscale serve` (tryb `system`) |

### Diagnostyka

`~/.dsh/remote-control.json`: `mode`, `backendState` (`NeedsLogin`, `Running`), `loginURL`, `url`, `owner`, `error`.

- `NeedsLogin`: otwórz `loginURL` i zaloguj się.
- `error` o HTTPS: włącz HTTPS Certificates w panelu Tailscale.
- 403 „Konto … nie ma dostępu”: telefon zalogowany innym kontem Tailscale niż komputer.

### Budowa dsh-tsnet.exe

Źródło w `tsnet/` (Go, `tailscale.com` przypięte w `go.mod`). Po aktualizacji Tailscale:

```
cd tsnet
go get tailscale.com@latest && go mod tidy
go build -trimpath -ldflags "-s -w -H windowsgui" -o ..\bin\dsh-tsnet.exe .
```

`-H windowsgui` (podsystem GUI) sprawia, że proces uruchamiany przez DSH nie otwiera okna konsoli.

### Testy

`node --test`: brama (tożsamość, sekret, CSRF, logowanie, WebSocket), API, nadzór nad dsh-tsnet,
parsowanie Tailscale CLI. Fałszywy serwer DSH odtwarza zachowanie 0.1.7-rc.2.

### Licencja

MIT (plik `LICENSE`). `bin/dsh-tsnet.exe` zawiera bibliotekę Tailscale (BSD-3-Clause) i Go
(BSD-3-Clause), patrz `THIRD_PARTY_NOTICES.md`.
