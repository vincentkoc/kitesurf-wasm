// Package kitesurf controls a local Kitesurf browser over CDP. It does not embed WASM.
package kitesurf

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// CDPError preserves a browser protocol error.
type CDPError struct {
	Method  string
	Code    int
	Message string
	Data    json.RawMessage
}

func (e *CDPError) Error() string { return fmt.Sprintf("%s: CDP %d: %s", e.Method, e.Code, e.Message) }

// Browser serializes commands; unsolicited events are discarded. Close disconnects
// attached servers and terminates only a process created by Launch.
type Browser struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	id      uint64
	timeout time.Duration
	process *exec.Cmd
	done    <-chan error
}

func Connect(ctx context.Context, endpoint string, timeout time.Duration) (*Browser, error) {
	if timeout <= 0 {
		return nil, errors.New("timeout must be positive")
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "ws" || u.User != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		return nil, errors.New("use an unauthenticated loopback ws:// endpoint")
	}
	handshake, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var stopInterrupt func() bool
	interrupted := make(chan struct{})
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			// Gorilla applies deadlines, but plain-ws handshake reads do not
			// otherwise wake up when a context is canceled before its deadline.
			stopInterrupt = context.AfterFunc(ctx, func() {
				conn.Close()
				close(interrupted)
			})
			return conn, nil
		},
	}
	conn, response, err := dialer.DialContext(handshake, endpoint, nil)
	// Disarm and join the callback before transferring connection ownership.
	// A buffered upgrade may succeed even after cancellation closed the socket.
	if stopInterrupt != nil && !stopInterrupt() {
		<-interrupted
	}
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if contextErr := handshake.Err(); contextErr != nil {
		if conn != nil {
			conn.Close()
		}
		return nil, contextErr
	}
	if err != nil {
		return nil, err
	}
	return &Browser{conn: conn, timeout: timeout}, nil
}

// Launch starts the explicit executable on an unused loopback port. The caller
// owns the returned Browser and must Close it. Startup failure reaps the child.
func Launch(ctx context.Context, binary string, port int, timeout time.Duration) (*Browser, error) {
	if timeout <= 0 || port < 1 || port > 65535 {
		return nil, errors.New("positive timeout and valid port required")
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	probe, err := net.Listen("tcp", address)
	if err != nil {
		return nil, err
	}
	probe.Close()
	cmd := exec.Command(binary, "--experimental", "--socket-addr=http="+address)
	// No inherited pipes: a verbose browser cannot deadlock waiting for a reader.
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	startup, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		select {
		case err = <-done:
			return nil, fmt.Errorf("browser exited during startup: %v", err)
		default:
		}
		browser, dialErr := Connect(startup, "ws://"+address+"/devtools/browser", 250*time.Millisecond)
		if dialErr == nil {
			if err = startup.Err(); err != nil {
				browser.Close()
				stop(cmd, done)
				return nil, err
			}
			select {
			case err = <-done:
				browser.Close()
				return nil, fmt.Errorf("browser exited during startup: %v", err)
			default:
			}
			browser.timeout, browser.process, browser.done = timeout, cmd, done
			return browser, nil
		}
		select {
		case <-startup.Done():
			stop(cmd, done)
			return nil, startup.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func stop(cmd *exec.Cmd, done <-chan error) {
	// Kill only our direct child, then reap it. No process-name/group killing.
	cmd.Process.Kill()
	<-done
}

func (b *Browser) closeLocked() error {
	var err error
	if b.conn != nil {
		err = b.conn.Close()
		b.conn = nil
	}
	if b.process != nil {
		stop(b.process, b.done)
		b.process = nil
	}
	return err
}
func (b *Browser) Close() error { b.mu.Lock(); defer b.mu.Unlock(); return b.closeLocked() }

// Command sends one request on a flattened session (empty for browser methods).
// Transport errors/cancellation close the connection to discard late responses.
// Lock acquisition is serialized and is not itself bounded by ctx's deadline.
func (b *Browser) Command(ctx context.Context, session, method string, params any, result any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.conn == nil {
		return errors.New("browser connection is closed")
	}
	b.id++
	message := map[string]any{"id": b.id, "method": method, "params": params}
	if params == nil {
		message["params"] = map[string]any{}
	}
	if session != "" {
		message["sessionId"] = session
	}
	deadline := time.Now().Add(b.timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	conn := b.conn
	conn.SetWriteDeadline(deadline)
	conn.SetReadDeadline(deadline)
	// Closing is safe concurrently with Read/Write and also interrupts cancellation
	// without a deadline; wait for the callback before returning the connection.
	interrupted := make(chan struct{})
	cancel := context.AfterFunc(ctx, func() { conn.Close(); close(interrupted) })
	defer func() {
		if !cancel() {
			<-interrupted
		}
	}()
	if err := conn.WriteJSON(message); err != nil {
		b.closeLocked()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	for {
		var response struct {
			ID     uint64          `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int             `json:"code"`
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			} `json:"error"`
		}
		if err := conn.ReadJSON(&response); err != nil {
			b.closeLocked()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if response.ID != b.id {
			continue
		}
		if response.Error != nil {
			return &CDPError{method, response.Error.Code, response.Error.Message, response.Error.Data}
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
}

// Page is a target and flattened session belonging to one browser. Calls may be
// serialized through Browser, but callers must not race Close with page methods.
type Page struct {
	browser   *Browser
	TargetID  string
	SessionID string
	closed    bool
}

func (b *Browser) NewPage(ctx context.Context) (*Page, error) {
	var target struct {
		TargetID string `json:"targetId"`
	}
	if err := b.Command(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &target); err != nil {
		return nil, err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := b.Command(ctx, "", "Target.attachToTarget", map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), b.timeout)
		defer cancel()
		b.Command(cleanup, "", "Target.closeTarget", map[string]any{"targetId": target.TargetID}, nil)
		return nil, err
	}
	return &Page{browser: b, TargetID: target.TargetID, SessionID: attached.SessionID}, nil
}
func (p *Page) Command(ctx context.Context, method string, params, result any) error {
	if p.closed {
		return errors.New("page is closed")
	}
	return p.browser.Command(ctx, p.SessionID, method, params, result)
}

// Navigate returns after the protocol response, not after network idle.
func (p *Page) Navigate(ctx context.Context, url string) error {
	var result struct {
		ErrorText string `json:"errorText"`
	}
	if err := p.Command(ctx, "Page.navigate", map[string]any{"url": url}, &result); err != nil {
		return err
	}
	if result.ErrorText != "" {
		return errors.New(result.ErrorText)
	}
	return nil
}

// Evaluate decodes a JSON-serializable value into result. Undefined and other
// non-JSON JavaScript values have no by-value representation.
func (p *Page) Evaluate(ctx context.Context, expression string, result any) error {
	var response struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails json.RawMessage `json:"exceptionDetails"`
	}
	if err := p.Command(ctx, "Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true}, &response); err != nil {
		return err
	}
	if len(response.ExceptionDetails) > 0 {
		return fmt.Errorf("JavaScript exception: %s", response.ExceptionDetails)
	}
	if len(response.Result.Value) == 0 {
		return errors.New("JavaScript result has no JSON value")
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(response.Result.Value, result)
}
func (p *Page) Screenshot(ctx context.Context) ([]byte, error) {
	var result struct {
		Data string `json:"data"`
	}
	if err := p.Command(ctx, "Page.captureScreenshot", map[string]any{"format": "png"}, &result); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(result.Data)
}
func (p *Page) Close(ctx context.Context) error {
	if p.closed {
		return nil
	}
	err := p.browser.Command(ctx, "", "Target.closeTarget", map[string]any{"targetId": p.TargetID}, nil)
	if err == nil {
		p.closed = true
	}
	return err
}
