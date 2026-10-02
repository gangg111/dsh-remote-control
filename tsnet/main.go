// dsh-tsnet: wbudowany wezel Tailscale (biblioteka tsnet) dla wtyczki dsh-remote-control.
//
// Bez sterownika VPN, uslugi systemowej i uprawnien administratora: proces dolacza do sieci
// Tailscale jako osobne urzadzenie, wystawia HTTPS na porcie 443 swojego wezla (certyfikat
// z Tailscale) i przekazuje ruch do bramy wtyczki na 127.0.0.1.
//
// Tozsamosc wywolujacego ustala WhoIs z polaczenia Tailscale (klient jej nie podrobi). Do bramy
// idzie jako Tailscale-User-Login razem z sekretem z biezacego startu (X-Dsh-Rc-Secret), wiec
// inny proces na tym komputerze nie zastapi tego programu.
//
// Konfiguracja przez zmienne srodowiska (ustawia je wtyczka):
//   DSH_RC_STATE_DIR  katalog stanu tsnet (klucze wezla; po zalogowaniu nie trzeba logowac ponownie)
//   DSH_RC_HOSTNAME   nazwa urzadzenia w sieci Tailscale (domyslnie dsh-pc)
//   DSH_RC_GATEWAY    adres bramy, np. 127.0.0.1:19390
//   DSH_RC_SECRET     sekret biezacego startu
//
// Na stdout wypisuje linie JSON ze stanem; konczy sie, gdy rodzic zamknie stdin.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

var out = json.NewEncoder(os.Stdout)
var outMu sync.Mutex
var logFile *os.File // <katalog nad stanem>/dsh-tsnet.log: te same zdarzenia, do diagnozy bez wtyczki

func emit(event map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = out.Encode(event)
	if logFile != nil && event["type"] != "log" {
		event["time"] = time.Now().Format(time.RFC3339)
		_ = json.NewEncoder(logFile).Encode(event)
	}
}

func fail(msg string, err error) {
	emit(map[string]any{"type": "error", "message": fmt.Sprintf("%s: %v", msg, err)})
	os.Exit(1)
}

func main() {
	dir := os.Getenv("DSH_RC_STATE_DIR")
	host := os.Getenv("DSH_RC_HOSTNAME")
	gateway := os.Getenv("DSH_RC_GATEWAY")
	secret := os.Getenv("DSH_RC_SECRET")
	if host == "" {
		host = "dsh-pc"
	}
	if dir == "" || gateway == "" || len(secret) < 16 {
		fail("konfiguracja", errors.New("wymagane DSH_RC_STATE_DIR, DSH_RC_GATEWAY i DSH_RC_SECRET (min. 16 znakow)"))
	}
	if f, err := os.OpenFile(filepath.Join(filepath.Dir(filepath.Clean(dir)), "dsh-tsnet.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		logFile = f
	}

	// Rodzic (wtyczka DSH) zamyka stdin przy wylaczeniu albo zgonie: wtedy konczymy proces.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	srv := &tsnet.Server{
		Dir:      dir,
		Hostname: host,
		Logf:     func(string, ...any) {},
		UserLogf: func(format string, args ...any) {
			emit(map[string]any{"type": "log", "message": strings.TrimSpace(fmt.Sprintf(format, args...))})
		},
	}
	if err := srv.Start(); err != nil {
		fail("start tsnet", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		fail("LocalClient", err)
	}

	target, _ := url.Parse("http://" + gateway)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host // brama porownuje Origin z Host zewnetrznym
		},
		FlushInterval: -1, // strumienie zdarzen DSH bez buforowania
		ErrorLog:      log.New(io.Discard, "", 0),
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil || who.UserProfile == nil || who.UserProfile.LoginName == "" {
			http.Error(w, "Nieznana tozsamosc Tailscale.", http.StatusForbidden)
			return
		}
		for name := range r.Header {
			if strings.HasPrefix(strings.ToLower(name), "tailscale-") || strings.EqualFold(name, "X-Dsh-Rc-Secret") {
				r.Header.Del(name)
			}
		}
		r.Header.Set("Tailscale-User-Login", who.UserProfile.LoginName)
		r.Header.Set("X-Dsh-Rc-Secret", secret)
		proxy.ServeHTTP(w, r)
	})

	go watchState(lc, host)

	ln, err := listenWhenRunning(srv, lc)
	if err != nil {
		fail("HTTPS w sieci Tailscale (wlacz HTTPS Certificates w panelu Tailscale)", err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 30 * time.Second, ErrorLog: log.New(tlsLogWriter{}, "", 0)}
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail("serwer HTTPS", err)
	}
}

// listenWhenRunning czeka na zalogowanie wezla, potem otwiera HTTPS na :443 (certyfikat z Tailscale).
func listenWhenRunning(srv *tsnet.Server, lc *local.Client) (net.Listener, error) {
	for {
		st, err := lc.StatusWithoutPeers(context.Background())
		if err == nil && st.BackendState == "Running" {
			break
		}
		time.Sleep(time.Second)
	}
	ln, err := srv.Listen("tcp", ":443")
	if err != nil {
		return nil, err
	}
	go prefetchCert(lc)
	getCert := func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, err := lc.GetCertificate(hello)
		if err != nil {
			emit(map[string]any{"type": "cert", "ok": false, "domain": hello.ServerName, "message": err.Error()})
		}
		return cert, err
	}
	return tls.NewListener(ln, &tls.Config{GetCertificate: getCert}), nil
}

// prefetchCert pobiera certyfikat dla nazwy wezla zaraz po zalogowaniu i melduje wynik, zeby blad
// (np. wylaczone HTTPS Certificates w panelu Tailscale) byl widoczny od razu, nie dopiero przy wejsciu z telefonu.
func prefetchCert(lc *local.Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	// Pierwszy stan Running bywa bez pelnej mapy sieci (brak wlasciciela i CertDomains): czekamy do 30 s.
	var domain string
	var certDomains []string
	for i := 0; i < 30; i++ {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil && st.Self != nil {
			domain = strings.TrimSuffix(st.Self.DNSName, ".")
			certDomains = st.CertDomains
			if len(certDomains) > 0 {
				break
			}
		}
		time.Sleep(time.Second)
	}
	emit(map[string]any{"type": "certDomains", "domain": domain, "certDomains": certDomains})
	if len(certDomains) == 0 {
		emit(map[string]any{"type": "cert", "ok": false, "domain": domain, "message": "sieć Tailscale nie wydaje certyfikatów (CertDomains puste po 30 s): włącz HTTPS Certificates w panelu (DNS) i MagicDNS"})
		return
	}
	if _, _, err := lc.CertPair(ctx, domain); err != nil {
		emit(map[string]any{"type": "cert", "ok": false, "domain": domain, "message": err.Error()})
		return
	}
	emit(map[string]any{"type": "cert", "ok": true, "domain": domain})
}

// tlsLogWriter przekazuje bledy serwera HTTP (np. nieudany uscisk TLS) jako zdarzenia JSON.
type tlsLogWriter struct{}

func (tlsLogWriter) Write(p []byte) (int, error) {
	emit(map[string]any{"type": "httpError", "message": strings.TrimSpace(string(p))})
	return len(p), nil
}

// watchState wypisuje zmiany stanu: NeedsLogin z linkiem logowania, Running z adresem i wlascicielem.
func watchState(lc *local.Client, host string) {
	last := ""
	for {
		st, err := lc.StatusWithoutPeers(context.Background())
		if err == nil {
			event := map[string]any{"type": "state", "backendState": st.BackendState, "authURL": st.AuthURL, "hostname": host}
			if st.Self != nil {
				event["dnsName"] = strings.TrimSuffix(st.Self.DNSName, ".")
				if u, ok := st.User[st.Self.UserID]; ok {
					event["owner"] = u.LoginName
				}
			}
			if st.CurrentTailnet != nil {
				event["magicDNS"] = st.CurrentTailnet.MagicDNSEnabled
			}
			key := fmt.Sprint(event)
			if key != last {
				last = key
				emit(event)
			}
		}
		time.Sleep(2 * time.Second)
	}
}
