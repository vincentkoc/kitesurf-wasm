package kitesurf

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestProtocol(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			var request struct {
				ID     uint64 `json:"id"`
				Method string `json:"method"`
			}
			if c.ReadJSON(&request) != nil {
				return
			}
			switch request.Method {
			case "hang":
				// Wait for the client to close on deadline/cancellation.
				c.ReadMessage()
				return
			case "unknown":
				c.WriteJSON(map[string]any{"id": request.ID, "error": map[string]any{"code": -32601, "message": "unknown"}})
			default:
				c.WriteJSON(map[string]any{"method": "Page.loadEventFired"})
				c.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{"answer": 42}})
			}
		}
	}))
	defer server.Close()
	endpoint := "ws" + strings.TrimPrefix(server.URL, "http")
	connectCtx, cancelConnect := context.WithCancel(context.Background())
	defer cancelConnect()
	b, err := Connect(connectCtx, endpoint, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	// The connect context owns only the handshake, not the returned browser.
	cancelConnect()
	var result struct{ Answer int }
	if err = b.Command(context.Background(), "", "example", nil, &result); err != nil || result.Answer != 42 {
		t.Fatalf("%+v %v", result, err)
	}
	var cdp *CDPError
	if err = b.Command(context.Background(), "", "unknown", nil, nil); !errors.As(err, &cdp) || cdp.Code != -32601 {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err = b.Command(ctx, "", "hang", nil, nil); err == nil {
		t.Fatal("expected timeout")
	}
	if err = b.Command(context.Background(), "", "example", nil, nil); err == nil {
		t.Fatal("transport must be closed")
	}
	b.Close()
}

func TestCancellation(t *testing.T) {
	u := websocket.Upgrader{}
	received := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := u.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		c.ReadMessage()
		close(received)
		c.ReadMessage()
	}))
	defer server.Close()
	b, err := Connect(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { <-received; cancel() }()
	if err = b.Command(ctx, "", "hang", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation: %v", err)
	}
}

// Cancellation must interrupt plain-ws HTTP reads, not just TCP dialing or
// handshakes whose peers eventually send a response.
func TestConnectCancellationInterruptsHandshake(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	release := make(chan struct{})
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		cancel()
		<-release // Withhold the upgrade until Connect has handled cancellation.
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			defer c.Close()
			c.SetReadDeadline(time.Now().Add(time.Second))
			c.ReadMessage()
		}
	}))
	defer server.Close()
	type result struct {
		browser *Browser
		err     error
	}
	returned := make(chan result, 1)
	go func() {
		b, err := Connect(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), 3*time.Second)
		if b != nil {
			b.Close()
		}
		returned <- result{b, err}
	}()
	select {
	case got := <-returned:
		if got.browser != nil || !errors.Is(got.err, context.Canceled) {
			t.Errorf("expected nil browser and cancellation, got %v, %v", got.browser, got.err)
		}
	case <-time.After(time.Second):
		t.Error("cancellation did not interrupt the pending handshake")
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("peer did not finish after handshake cancellation")
	}
}

func TestConnectRejectsLateHandshakeSuccess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := false
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotFirstResponseByte: func() {
			// Gorilla can complete from buffered upgrade headers after this.
			observed = true
			cancel()
		},
	})
	disconnected := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			disconnected <- err
			return
		}
		defer c.Close()
		c.SetReadDeadline(time.Now().Add(time.Second))
		_, _, err = c.ReadMessage()
		disconnected <- err
	}))
	defer server.Close()
	b, err := Connect(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), time.Second)
	if b != nil {
		defer b.Close()
	}
	if !observed {
		t.Fatal("did not reach the handshake response boundary")
	}
	if b != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected nil browser and cancellation, got %v, %v", b, err)
	}
	select {
	case err := <-disconnected:
		if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("late handshake transport was not closed")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("peer did not observe disconnect")
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}
func TestLaunchFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := Launch(ctx, "/nonexistent", freePort(t), time.Second); err == nil {
		t.Fatal("expected missing binary")
	}
	if _, err := Connect(ctx, "ws://example.org/devtools/browser", time.Second); err == nil {
		t.Fatal("expected remote rejection")
	}
}
func TestStartupTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	script := filepath.Join(t.TempDir(), "hang")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 20\n"), 0700); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := Launch(context.Background(), script, freePort(t), 50*time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected startup deadline: %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("startup cleanup hung")
	}
}
func TestBrowserSmoke(t *testing.T) {
	binary := os.Getenv("KITESURF_BINARY")
	if binary == "" {
		t.Skip("set KITESURF_BINARY for real browser smoke")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	port := freePort(t)
	b, err := Launch(ctx, binary, port, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	process := b.process
	endpoint := "ws://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + "/devtools/browser"
	attached, err := Connect(ctx, endpoint, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err = attached.Command(ctx, "", "Browser.getVersion", nil, nil); err != nil {
		t.Fatal(err)
	}
	attached.Close()
	p, err := b.NewPage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Navigate(ctx, "data:text/html,"+url.PathEscape("<title>Go binding</title><h1>hello</h1>")); err != nil {
		t.Fatal(err)
	}
	var title string
	if err = p.Evaluate(ctx, "document.title", &title); err != nil || title != "Go binding" {
		t.Fatalf("%q %v", title, err)
	}
	var answer int
	if err = p.Evaluate(ctx, "6*7", &answer); err != nil || answer != 42 {
		t.Fatalf("%d %v", answer, err)
	}
	png, err := p.Screenshot(ctx)
	if err != nil || !strings.HasPrefix(string(png), "\x89PNG\r\n\x1a\n") {
		t.Fatalf("PNG: %v", err)
	}
	var cdp *CDPError
	if err = p.Command(ctx, "NotAReal.method", nil, nil); !errors.As(err, &cdp) {
		t.Fatalf("expected CDP error: %v", err)
	}
	if err = p.Evaluate(ctx, "throw new Error('expected')", nil); err == nil {
		t.Fatal("expected JavaScript error")
	}
	if err = p.Evaluate(ctx, "globalThis.bindingSecret=123", nil); err != nil {
		t.Fatal(err)
	}
	if err = p.Navigate(ctx, "data:text/html,<h1>new</h1>"); err != nil {
		t.Fatal(err)
	}
	if err = p.Evaluate(ctx, "typeof bindingSecret", &title); err != nil || title != "undefined" {
		t.Fatalf("isolation %q %v", title, err)
	}
	second, err := b.NewPage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = second.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err = p.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err = p.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err = p.Evaluate(ctx, "1", nil); err == nil {
		t.Fatal("expected closed page")
	}
	b.Close()
	b.Close()
	if process.ProcessState == nil {
		t.Fatal("child was not reaped")
	}
}
