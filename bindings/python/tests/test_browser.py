import base64
import hashlib
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import Mock, patch

import websocket

from kitesurf_browser import Browser, CDPError


class LocalPeer:
    """A single local HTTP/WebSocket peer; no external server dependency."""
    def __init__(self, handler, *, redirect=None, handshake=None, port=0, host="127.0.0.1"):
        self.handler, self.redirect, self.handshake = handler, redirect, handshake
        self.finished = threading.Event()
        self.errors = []
        self.listener = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
        self.listener.bind((host, port))
        self.listener.listen(1)
        self.listener.settimeout(2)
        authority = f'[{host}]' if ':' in host else host
        self.endpoint = f'ws://{authority}:{self.listener.getsockname()[1]}/'
        self.connection = None
        self.thread = threading.Thread(target=self.serve)

    def serve(self):
        try:
            connection, _ = self.listener.accept()
            self.connection = connection
            with connection:
                connection.settimeout(2)
                request = b''
                while b'\r\n\r\n' not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        return
                    request += chunk
                if self.redirect:
                    connection.sendall(('HTTP/1.1 302 Found\r\nLocation: ' + self.redirect +
                                        '\r\nContent-Length: 0\r\n\r\n').encode())
                    return
                headers = dict(line.split(': ', 1) for line in request.decode().split('\r\n')[1:] if ': ' in line)
                key = headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
                accept = base64.b64encode(hashlib.sha1(key.encode()).digest()).decode()
                response = ('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                            'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n').encode()
                if self.handshake:
                    self.handshake(connection, response)
                else:
                    connection.sendall(response)
                peer = websocket.WebSocket()
                peer.sock, peer.connected = connection, True
                if self.handler:
                    self.handler(connection, peer)
        except (OSError, websocket.WebSocketConnectionClosedException):
            pass  # Expected when the client aborts a pending command.
        except BaseException as error:
            self.errors.append(error)
        finally:
            self.finished.set()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        if self.connection is not None:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.listener.close()
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            raise AssertionError('test peer leaked a thread')
        if self.errors:
            raise self.errors[0]


def frame(data, opcode=websocket.ABNF.OPCODE_TEXT, fin=1):
    result = websocket.ABNF.create_frame(data, opcode, fin)
    result.mask_value = 0  # Server frames are not masked.
    return result.format()


class ProtocolTest(unittest.TestCase):
    def test_events_errors_and_close(self):
        ws = Mock()
        ws.recv.side_effect = ['{"method":"Page.loadEventFired"}', '{"id":1,"result":{"answer":42}}',
                               '{"id":2,"error":{"code":-32601,"message":"unknown"}}']
        browser = Browser(ws, 1)
        self.assertEqual(browser.command('example')['answer'], 42)
        with self.assertRaises(CDPError) as caught:
            browser.command('unknown')
        self.assertEqual(caught.exception.error['code'], -32601)
        browser.close()
        browser.close()
        ws.shutdown.assert_called_once()
        with self.assertRaises(RuntimeError):
            browser.command('example')

    def test_transport_failure_closes(self):
        ws = Mock()
        ws.recv.side_effect = TimeoutError('deadline')
        browser = Browser(ws, 0.01)
        with self.assertRaises(TimeoutError):
            browser.command('hang')
        ws.shutdown.assert_called_once()

    def test_reject_remote_and_invalid_timeouts(self):
        with self.assertRaises(ValueError):
            Browser.connect('ws://example.org/devtools/browser')
        for timeout in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                Browser.connect(timeout=timeout)

    def test_localhost_uses_loopback_socket(self):
        with LocalPeer(lambda connection, peer: connection.recv(1)) as server:
            with Browser.connect(server.endpoint.replace('127.0.0.1', 'localhost'), timeout=1):
                pass
            self.assertTrue(server.finished.wait(0.5))

    @unittest.skipUnless(socket.has_ipv6, 'IPv6 unavailable')
    def test_ipv6_and_localhost_fallback(self):
        for host in ('[::1]', 'localhost'):
            with self.subTest(host=host):
                try:
                    server = LocalPeer(lambda connection, peer: connection.recv(1), host='::1')
                except OSError as error:
                    self.skipTest(f'IPv6 loopback unavailable: {error}')
                with server:
                    with Browser.connect(server.endpoint.replace('[::1]', host), timeout=1):
                        pass
                    self.assertTrue(server.finished.wait(0.5))

    def test_redirect_off_loopback_is_not_followed(self):
        from websocket import _http
        original_connect = _http.connect
        destinations = []

        def local_only(url, *args, **kwargs):
            destinations.append(url)
            if not url.startswith('ws://127.0.0.1:'):
                raise AssertionError('attempted to follow non-loopback redirect')
            return original_connect(url, *args, **kwargs)

        with LocalPeer(None, redirect='ws://example.org/devtools/browser') as server:
            with patch('websocket._core.connect', side_effect=local_only):
                with self.assertRaises(websocket.WebSocketException):
                    Browser.connect(server.endpoint)
            self.assertEqual(destinations, [server.endpoint])
            self.assertTrue(server.finished.wait(1))

    def test_close_does_not_wait_for_partial_frame(self):
        sending = threading.Event()

        def handle(connection, peer):
            connection.sendall(frame('x' * 1000)[:4])
            sending.set()
            for _ in range(150):
                connection.sendall(b'x')
                time.sleep(0.01)

        with LocalPeer(handle) as server:
            browser = Browser.connect(server.endpoint, timeout=1)
            process = Mock()
            process.poll.return_value = None
            browser._process = process
            self.assertTrue(sending.wait(1))
            start = time.monotonic()
            browser.close()
            self.assertLess(time.monotonic() - start, 0.3)
            self.assertIsNone(browser._ws)
            self.assertIsNone(browser._process)
            process.terminate.assert_called_once()
            process.wait.assert_called_once()
            self.assertTrue(server.finished.wait(0.5), 'peer did not observe disconnect')
            browser.close()

    @staticmethod
    def trickle_handshake(connection, response):
        for byte in response:
            connection.sendall(bytes([byte]))
            time.sleep(0.005)

    def test_handshake_has_absolute_deadline(self):
        with LocalPeer(None, handshake=self.trickle_handshake) as server:
            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                Browser.connect(server.endpoint, timeout=0.05)
            self.assertLess(time.monotonic() - start, 0.3)
            self.assertTrue(server.finished.wait(0.5), 'handshake socket was not closed')

    def test_late_handshake_success_is_rejected(self):
        original_connect = websocket.WebSocket.connect
        connections = []

        def late_connect(ws, *args, **kwargs):
            original_connect(ws, *args, **kwargs)
            connections.append(ws)
            time.sleep(0.1)  # Model work returning after its transport was aborted.

        with LocalPeer(lambda connection, peer: connection.recv(1)) as server:
            with patch.object(websocket.WebSocket, 'connect', late_connect):
                with self.assertRaises(TimeoutError):
                    Browser.connect(server.endpoint, timeout=0.05)
            self.assertEqual(len(connections), 1)
            self.assertIsNone(connections[0].sock)
            self.assertTrue(server.finished.wait(0.5))

    def test_startup_trickle_handshake_reaps_child(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        process = Mock()
        process.poll.return_value = None
        servers = []

        def start_process(*args, **kwargs):
            server = LocalPeer(None, handshake=self.trickle_handshake, port=port)
            servers.append(server)
            server.__enter__()
            return process

        try:
            with patch('kitesurf_browser.subprocess.Popen', side_effect=start_process):
                start = time.monotonic()
                with self.assertRaises(TimeoutError):
                    Browser.launch('unused-test-binary', port=port, timeout=0.05)
                self.assertLess(time.monotonic() - start, 0.3)
                process.terminate.assert_called_once()
                process.wait.assert_called_once()
                self.assertTrue(servers[0].finished.wait(0.5))
        finally:
            for server in servers:
                server.__exit__(None, None, None)

    def test_startup_rejects_late_connect_result(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        process = Mock()
        process.poll.return_value = None
        ws = Mock()
        browser = Browser(ws, 1)

        def late_connect(*args, **kwargs):
            time.sleep(0.06)
            return browser

        with patch('kitesurf_browser.subprocess.Popen', return_value=process):
            with patch.object(Browser, 'connect', side_effect=late_connect):
                with self.assertRaises(TimeoutError):
                    Browser.launch('unused-test-binary', port=port, timeout=0.02)
        self.assertIsNone(browser._ws)
        process.terminate.assert_called_once()
        process.wait.assert_called_once()

    def test_absolute_deadline_for_control_fragments_and_partial_reads(self):
        for mode in ('ping', 'fragment', 'partial_header', 'partial_payload'):
            with self.subTest(mode=mode):
                def handle(connection, peer):
                    peer.recv()  # Wait until the command and its timer exist.
                    if mode == 'partial_payload':
                        data = frame('x' * 1000)
                        connection.sendall(data[:4])  # Complete extended header.
                    elif mode == 'partial_header':
                        data = b'\x81\x7f' + (1000).to_bytes(8, 'big')
                    for index in range(100):
                        if mode == 'ping':
                            connection.sendall(frame('ping', websocket.ABNF.OPCODE_PING))
                        elif mode == 'fragment':
                            opcode = websocket.ABNF.OPCODE_TEXT if index == 0 else websocket.ABNF.OPCODE_CONT
                            connection.sendall(frame(' ', opcode, fin=0))
                        elif mode == 'partial_header':
                            if index < len(data):
                                connection.sendall(data[index:index + 1])
                        else:
                            connection.sendall(b'x')
                        time.sleep(0.01)

                with LocalPeer(handle) as server:
                    browser = Browser.connect(server.endpoint, timeout=1)
                    browser.timeout = 0.05
                    process = Mock()
                    process.poll.return_value = None
                    browser._process = process
                    start = time.monotonic()
                    with self.assertRaises(TimeoutError):
                        browser.command('hang')
                    self.assertLess(time.monotonic() - start, 0.3)
                    self.assertIsNone(browser._ws)
                    self.assertIsNone(browser._process)
                    process.terminate.assert_called_once()
                    process.wait.assert_called_once()
                    self.assertTrue(server.finished.wait(0.5), 'peer did not observe disconnect')
                    with self.assertRaises(RuntimeError):
                        browser.command('again')
                    browser.close()

    def test_late_response_is_rejected_even_if_recv_returns(self):
        for response in ('{"id":1,"result":{"answer":42}}',
                         '{"id":1,"error":{"code":-32601,"message":"late error"}}'):
            with self.subTest(response=response):
                ws = Mock()
                def late_response():
                    time.sleep(0.06)
                    return response
                ws.recv.side_effect = late_response
                browser = Browser(ws, 0.02)
                with self.assertRaises(TimeoutError):
                    browser.command('late')
                ws.abort.assert_called_once()
                ws.shutdown.assert_called_once()
                self.assertIsNone(browser._ws)

    def test_launch_failure_and_occupied_port(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            with self.assertRaises(OSError):
                Browser.launch('/nonexistent', port=listener.getsockname()[1])
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'hang'
            script.write_text('#!/bin/sh\nexec sleep 20\n')
            script.chmod(0o700)
            # Timeout path must terminate and reap the child rather than leave it.
            with self.assertRaises(TimeoutError):
                Browser.launch(script, port=port, timeout=0.1)


@unittest.skipUnless(os.environ.get('KITESURF_BINARY'), 'set KITESURF_BINARY for real browser smoke')
class BrowserSmoke(unittest.TestCase):
    def test_real_browser(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with Browser.launch(os.environ['KITESURF_BINARY'], port=port) as browser:
            process = browser._process
            # Closing an attached connection must not kill the server we own.
            with Browser.connect(f'ws://127.0.0.1:{port}/devtools/browser') as attached:
                attached.command('Browser.getVersion')
            self.assertIsNone(process.poll())
            with browser.new_page() as page:
                page.navigate('data:text/html,' + quote('<title>Python binding</title><p id="result">hello</p>'))
                self.assertEqual(page.evaluate('document.title'), 'Python binding')
                self.assertEqual(page.evaluate('6 * 7'), 42)
                self.assertTrue(page.screenshot().startswith(b'\x89PNG\r\n\x1a\n'))
                with self.assertRaises(CDPError):
                    page.command('NotAReal.method')
                with self.assertRaises(RuntimeError):
                    page.evaluate('throw new Error("expected")')
                page.evaluate('globalThis.bindingSecret = 123')
                page.navigate('data:text/html,<h1>new document</h1>')
                self.assertEqual(page.evaluate('typeof bindingSecret'), 'undefined')
                with browser.new_page() as second:
                    second.navigate('data:text/html,<title>second</title>')
                    self.assertEqual(second.evaluate('document.title'), 'second')
                page.close()
                with self.assertRaises(RuntimeError):
                    page.evaluate('1')
        self.assertIsNotNone(process.poll())
        browser.close()


if __name__ == '__main__':
    unittest.main()
