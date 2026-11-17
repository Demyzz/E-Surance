"""The client's connection to the server.

The client keeps one TCP connection for the whole session, sends one request,
and waits for one reply (request-reply).

Failures: if the connection breaks during a request, the client reports
"the server is not available" and does NOT send the request again: the
server may already have done the action (at-most-once invocation semantics).
The next request opens a new connection and logs in again by itself, so the
user continues with the same records after the server restarts.
"""

import select
import socket
import threading

from common.protocol import (
    DEFAULT_SERVER_PORT,
    ConnectionClosed,
    ProtocolError,
    recv_message,
    request,
    send_message,
)

REQUEST_TIMEOUT = 10


class ServerUnavailable(Exception):
    def __init__(self):
        super().__init__("the server is not available")


class RemoteError(Exception):
    """The server refused the request; the message is the server's reason."""


class EsuranceClient:
    def __init__(self, host="127.0.0.1", port=DEFAULT_SERVER_PORT, timeout=REQUEST_TIMEOUT):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.user = None
        self._sock = None
        self._lock = threading.Lock()      # one request at a time on the socket
        self._credentials = None           # kept for the automatic login again

    # -- requests ----------------------------------------------------------

    def request(self, action, **data):
        """Send one request; return the reply dict {"ok": ..., ...}."""
        with self._lock:
            if self._sock is not None and _closed_by_server(self._sock):
                self._drop()
            if self._sock is None:
                self._open()
                if self._credentials is not None and action != "LOGIN":
                    self._login_again()
            return self._send(request(action, **data))

    def call(self, action, **data):
        """Like request(), but return the data or raise RemoteError."""
        reply = self.request(action, **data)
        if not reply.get("ok"):
            raise RemoteError(reply.get("error", "request refused"))
        return reply.get("data")

    def login(self, username, password, p2p_port=None):
        reply = self.request("LOGIN", username=username, password=password, p2p_port=p2p_port)
        if reply.get("ok"):
            self._credentials = {"username": username, "password": password, "p2p_port": p2p_port}
            self.user = reply["data"]
        return reply

    def logout(self):
        """Log out on the open connection. It never reconnects just to log out."""
        with self._lock:
            logged_in = self._credentials is not None
            self._credentials = None
            self.user = None
            if not logged_in or self._sock is None or _closed_by_server(self._sock):
                self._drop()
                return None
            return self._send(request("LOGOUT"))

    def close(self):
        try:
            self.logout()
        except ServerUnavailable:
            pass
        with self._lock:
            self._drop()

    # -- connection --------------------------------------------------------

    def _open(self):
        try:
            self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as exc:
            self._sock = None
            raise ServerUnavailable() from exc

    def _drop(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None

    def _send(self, message):
        try:
            send_message(self._sock, message)
            return recv_message(self._sock)
        except (OSError, ConnectionClosed, ProtocolError) as exc:
            self._drop()
            raise ServerUnavailable() from exc

    def _login_again(self):
        reply = self._send(request("LOGIN", **self._credentials))
        if not reply.get("ok"):
            self._credentials = None
            self.user = None
            raise RemoteError(f"automatic login failed: {reply.get('error')}")
        self.user = reply["data"]


def _closed_by_server(sock):
    """True if the server closed this connection while the client was idle.

    The server never sends without a request, so a readable socket here means
    end of connection. Checking before sending is safe: nothing was sent yet.
    """
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True
