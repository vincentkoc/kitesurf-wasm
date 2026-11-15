"""Local browser CDP bindings, not an in-process WASM embedding."""
import base64
import json
import math
import socket
import subprocess
import threading
import time
from urllib.parse import urlsplit

import websocket


class CDPError(RuntimeError):
    """An error response from the browser, with the original CDP payload."""
    def __init__(self, method, error):
        self.method, self.error = method, error
        super().__init__(f"{method}: {error}")


class Browser:
    """One serialized CDP connection. close() never stops an attached server."""
    def __init__(self, ws, timeout, process=None):
        self._ws, self.timeout, self._process = ws, timeout, process
        self._lock = threading.RLock()
        self._id = 0

    @classmethod
    def connect(cls, endpoint="ws://127.0.0.1:18787/devtools/browser", *, timeout=30):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        url = urlsplit(endpoint)
        if url.scheme != "ws" or url.hostname not in ("127.0.0.1", "::1", "localhost") or url.username or url.password:
            raise ValueError("use an unauthenticated loopback ws:// endpoint")
        ws = websocket.create_connection(endpoint, timeout=timeout, redirect_limit=0,
                                         http_no_proxy=["127.0.0.1", "localhost", "::1"])
        # websocket-client 1.8 returns a connected object even for an unfollowed
        # redirect. Never accept that object or follow a redirect off loopback.
        if ws.getstatus() != 101:
            ws.shutdown()
            raise websocket.WebSocketException("expected HTTP 101; redirects are disabled")
        return cls(ws, timeout)

    @classmethod
    def launch(cls, binary, *, port=18787, timeout=30):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be finite and positive")
        if not 1 <= port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        # Never intentionally attach to an already-running service.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
        process = subprocess.Popen([str(binary), "--experimental", f"--socket-addr=http=127.0.0.1:{port}"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"browser exited with code {process.returncode}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    browser = cls.connect(f"ws://127.0.0.1:{port}/devtools/browser", timeout=min(0.25, remaining))
                    if process.poll() is not None:
                        browser.close()
                        raise RuntimeError("browser exited during startup")
                    browser.timeout, browser._process = timeout, process
                    return browser
                except (OSError, websocket.WebSocketException):
                    time.sleep(0.02)
            raise TimeoutError("browser startup timed out")
        except BaseException:
            cls._stop(process)
            raise

    @staticmethod
    def _stop(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def command(self, method, params=None, *, session_id=None):
        with self._lock:
            if self._ws is None:
                raise RuntimeError("browser connection is closed")
            self._id += 1
            message = {"id": self._id, "method": method, "params": params or {}}
            if session_id:
                message["sessionId"] = session_id
            deadline = time.monotonic() + self.timeout
            ws = self._ws

            def abort():
                # recv() handles control frames and partial reads internally;
                # per-socket timeouts alone cannot impose a command deadline.
                try:
                    ws.abort()
                except (OSError, AttributeError):
                    pass  # The peer may already have closed the socket.

            timer = threading.Timer(max(0, deadline - time.monotonic()), abort)
            timer.daemon = True
            try:
                timer.start()
                try:
                    ws.settimeout(self.timeout)
                    ws.send(json.dumps(message))
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError(f"{method} timed out")
                        ws.settimeout(remaining)
                        response = json.loads(ws.recv())
                        if time.monotonic() >= deadline:
                            raise TimeoutError(f"{method} timed out")
                        if response.get("id") != self._id:
                            continue  # unsolicited events are not response frames
                        break
                finally:
                    # Join before returning/cleanup so an old timer cannot abort
                    # the next command or race with socket destruction.
                    timer.cancel()
                    timer.join()
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"{method} timed out")
                if "error" in response:
                    raise CDPError(method, response["error"])
                return response.get("result", {})
            except CDPError:
                raise
            except BaseException as error:
                # Skip the graceful close handshake on a broken transport: it
                # can itself be kept busy by a peer streaming partial frames.
                try:
                    ws.shutdown()
                finally:
                    self.close()
                if isinstance(error, websocket.WebSocketTimeoutException) or (
                    isinstance(error, Exception) and time.monotonic() >= deadline
                ):
                    raise TimeoutError(f"{method} timed out") from error
                raise

    def new_page(self):
        target = self.command("Target.createTarget", {"url": "about:blank"})["targetId"]
        try:
            session = self.command("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            return Page(self, target, session)
        except BaseException:
            if self._ws is not None:
                self.command("Target.closeTarget", {"targetId": target})
            raise

    def close(self):
        with self._lock:
            ws, self._ws = self._ws, None
            try:
                if ws is not None:
                    ws.close(timeout=1)
            finally:
                if self._process is not None:
                    self._stop(self._process)
                    self._process = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class Page:
    def __init__(self, browser, target_id, session_id):
        self.browser, self.target_id, self.session_id = browser, target_id, session_id
        self._closed = False

    def command(self, method, params=None):
        if self._closed:
            raise RuntimeError("page is closed")
        return self.browser.command(method, params, session_id=self.session_id)

    def navigate(self, url):
        """Return the Page.navigate response; not a network-idle wait."""
        result = self.command("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise RuntimeError(result["errorText"])
        return result

    def evaluate(self, expression):
        result = self.command("Runtime.evaluate", {"expression": expression, "returnByValue": True})
        if "exceptionDetails" in result:
            raise RuntimeError(f"JavaScript exception: {result['exceptionDetails']}")
        return result.get("result", {}).get("value")

    def screenshot(self):
        return base64.b64decode(self.command("Page.captureScreenshot", {"format": "png"})["data"], validate=True)

    def close(self):
        if not self._closed:
            self.browser.command("Target.closeTarget", {"targetId": self.target_id})
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
