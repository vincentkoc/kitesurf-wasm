import os
import socket
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
from unittest.mock import Mock

from kitesurf_browser import Browser, CDPError


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
        ws.close.assert_called_once()
        with self.assertRaises(RuntimeError):
            browser.command('example')

    def test_transport_failure_closes(self):
        ws = Mock()
        ws.recv.side_effect = TimeoutError('deadline')
        browser = Browser(ws, 0.01)
        with self.assertRaises(TimeoutError):
            browser.command('hang')
        ws.close.assert_called_once()

    def test_reject_remote_and_invalid_timeouts(self):
        with self.assertRaises(ValueError):
            Browser.connect('ws://example.org/devtools/browser')
        for timeout in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                Browser.connect(timeout=timeout)

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
