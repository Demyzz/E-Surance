"""Web bridge: lets a browser use E-Surance.

A browser cannot open raw TCP sockets, so each user's computer runs this
bridge next to the web frontend. For each browser login the bridge keeps the
two parts of a client program:

  - an EsuranceClient: the one TCP connection to the server (port 5000)
  - a PeerNode: its own listen port for direct messages and documents

The browser talks to the bridge over HTTP on this computer. Incoming peer
messages and documents reach the browser at once as Server-Sent Events.

    python bridge.py --server 192.168.1.10:5000

The records still go through the server, and the documents still go
directly from one user's peer node to the other's: the bridge only turns
browser clicks into the same protocol messages that the text menu sends.
"""

import argparse
import itertools
import json
import logging
import mimetypes
import os
import queue
import secrets
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from client.api import EsuranceClient, RemoteError, ServerUnavailable
from common.protocol import CHUNK_SIZE, DEFAULT_SERVER_PORT, parse_address
from peer.node import MAX_FILE_SIZE, PeerError, PeerNode, file_checksum, safe_filename

log = logging.getLogger("esurance.bridge")

DEFAULT_BRIDGE_PORT = 8000
MAX_JSON_BODY = 1024 * 1024
SESSION_IDLE_SECONDS = 15 * 60
EVENT_HEARTBEAT_SECONDS = 15
HISTORY_LIMIT = 500
# Accounts are made and changed with these endpoints, not with /api/call.
RESERVED_ACTIONS = {"LOGIN", "LOGOUT", "REGISTER"}

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_STATIC_DIR = os.path.join(HERE, "frontend", "ui", "dist")


def _now():
    return datetime.now().isoformat(timespec="seconds")


class HttpError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


class BridgeSession:
    """One browser login: a server connection and a peer node."""

    _ids = itertools.count(1)

    def __init__(self, bridge, username):
        self.token = secrets.token_urlsafe(24)
        self.username = username
        self.inbox = os.path.join(bridge.data_dir, "received", safe_filename(username))
        self.client = EsuranceClient(*bridge.server_address)
        self.node = PeerNode(username, host=bridge.peer_host, port=bridge.next_peer_port(),
                             inbox=self.inbox, on_chat=self._on_chat, on_file=self._on_file)
        self.user = None
        self.history = []
        self.last_seen = time.monotonic()
        self._received = {}            # file name -> sender, time
        self._checksums = {}           # (name, size, mtime) -> sha256
        self._subscribers = []
        self._lock = threading.Lock()

    def open(self, password):
        self.node.start()
        try:
            reply = self.client.login(self.username, password, self.node.port)
        except ServerUnavailable:
            self.close()
            raise
        if not reply.get("ok"):
            self.close()
            raise HttpError(401, reply.get("error", "login refused"))
        self.user = reply["data"]
        log.info("%s logged in through the bridge, peer port %d", self.username, self.node.port)

    def close(self):
        try:
            self.client.close()
        except Exception:
            pass
        self.node.stop()
        self.publish({"type": "closed"})

    # -- live events -------------------------------------------------------

    def subscribe(self):
        q = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def has_subscribers(self):
        with self._lock:
            return bool(self._subscribers)

    def publish(self, event):
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(event)

    def remember(self, entry):
        entry = {"id": next(self._ids), "at": _now(), **entry}
        with self._lock:
            self.history.append(entry)
            del self.history[:-HISTORY_LIMIT]
        return entry

    def _on_chat(self, sender, text):
        entry = self.remember({"direction": "in", "peer": sender, "text": text})
        self.publish({"type": "message", "message": entry})

    def _on_file(self, sender, path, size, sha256):
        name = os.path.basename(path)
        with self._lock:
            self._received[name] = {"from": sender, "at": _now()}
        document = {"filename": name, "size": size, "sha256": sha256}
        entry = self.remember({"direction": "in", "peer": sender, "document": document})
        self.publish({"type": "message", "message": entry})

    # -- received documents ------------------------------------------------

    def received_files(self):
        if not os.path.isdir(self.inbox):
            return []
        files = []
        for name in sorted(os.listdir(self.inbox)):
            path = os.path.join(self.inbox, name)
            if name.startswith(".") or not os.path.isfile(path):
                continue                       # skip .part files of transfers in progress
            stat = os.stat(path)
            key = (name, stat.st_size, stat.st_mtime_ns)
            if key not in self._checksums:
                self._checksums[key] = file_checksum(path)[1]
            with self._lock:
                meta = self._received.get(name, {})
            files.append({"filename": name, "size": stat.st_size, "sha256": self._checksums[key],
                          "from": meta.get("from"), "at": meta.get("at")})
        return files

    def refresh_directory(self):
        """Ask the server where the online users are. None if it is down."""
        try:
            entries = self.client.call("LIST_PEERS")
        except (ServerUnavailable, RemoteError):
            return None
        self.node.update_from_directory(entries)
        return entries


class Bridge:
    def __init__(self, server_address, host="127.0.0.1", port=DEFAULT_BRIDGE_PORT,
                 data_dir=".", static_dir=DEFAULT_STATIC_DIR, peer_host="0.0.0.0", peer_port=0):
        self.server_address = server_address
        self.host = host
        self.port = port
        self.data_dir = data_dir
        self.static_dir = os.path.abspath(static_dir) if static_dir else None
        self.peer_host = peer_host
        self._peer_ports = itertools.count(peer_port) if peer_port else None
        self.sessions = {}
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self.httpd = None

    def next_peer_port(self):
        """--peer-port 6001 gives 6001, 6002, ... to the logins; else any free port."""
        return next(self._peer_ports) if self._peer_ports else 0

    # -- start and stop ----------------------------------------------------

    def start(self):
        handler = type("Handler", (BridgeHandler,), {"bridge": self})
        self.httpd = ThreadingHTTPServer((self.host, self.port), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.5},
                         name="bridge-http", daemon=True).start()
        threading.Thread(target=self._clean_idle_sessions, name="bridge-cleanup", daemon=True).start()
        log.info("bridge on http://%s:%d, server %s:%d", self.host, self.port, *self.server_address)
        return self

    def shutdown(self):
        self._stopping.set()
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
        with self._lock:
            sessions = list(self.sessions.values())
            self.sessions.clear()
        for session in sessions:
            session.close()

    def _clean_idle_sessions(self):
        while not self._stopping.wait(30):
            now = time.monotonic()
            with self._lock:
                idle = [s for s in self.sessions.values()
                        if not s.has_subscribers() and now - s.last_seen > SESSION_IDLE_SECONDS]
                for session in idle:
                    del self.sessions[session.token]
            for session in idle:
                log.info("closing idle session of %s", session.username)
                session.close()

    # -- sessions ----------------------------------------------------------

    def login(self, username, password):
        session = BridgeSession(self, username)
        session.open(password)
        with self._lock:
            self.sessions[session.token] = session
        return session

    def logout(self, token):
        with self._lock:
            session = self.sessions.pop(token, None)
        if session is not None:
            session.close()

    def session(self, token):
        with self._lock:
            session = self.sessions.get(token or "")
        if session is None:
            raise HttpError(401, "log in first", logged_out=True)
        session.last_seen = time.monotonic()
        return session


class BridgeHandler(BaseHTTPRequestHandler):
    bridge = None
    server_version = "E-SuranceBridge/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        url = urlparse(self.path)
        self.query = parse_qs(url.query)
        path = url.path
        try:
            if not path.startswith("/api/"):
                if method != "GET":
                    raise HttpError(405, "method not allowed")
                return self._static(path)
            if method == "GET" and path.startswith("/api/received/"):
                return self._download(unquote(path[len("/api/received/"):]))
            route = self.ROUTES.get((method, path))
            if route is None:
                raise HttpError(404, "not found")
            result = route(self)
            if result is not None:
                self._json(200, result)
        except HttpError as exc:
            self._json(exc.status, {"ok": False, "error": exc.message, **exc.extra})
        except ServerUnavailable:
            self._json(503, {"ok": False, "error": "the server is not available", "server_down": True})
        except RemoteError as exc:
            self._json(422, {"ok": False, "error": str(exc)})
        except PeerError as exc:
            self._json(502, {"ok": False, "error": str(exc), "peer_error": True})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.exception("bridge error on %s %s", method, path)
            self._json(500, {"ok": False, "error": "internal bridge error"})

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_JSON_BODY:
            raise HttpError(413, "request is larger than 1 MB")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "body must be JSON") from None
        if not isinstance(data, dict):
            raise HttpError(400, "body must be a JSON object")
        return data

    def _token(self):
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            return header[len("Bearer "):].strip()
        return (self.query.get("token") or [""])[0]

    def _session(self):
        return self.bridge.session(self._token())

    def _param(self, name):
        value = (self.query.get(name) or [""])[0].strip()
        if not value:
            raise HttpError(400, f"{name} is required")
        return value

    # -- accounts ----------------------------------------------------------

    def health(self):
        host, port = self.bridge.server_address
        return {"ok": True, "data": {"bridge": "running", "server": f"{host}:{port}"}}

    def register(self):
        data = self._body_json()
        client = EsuranceClient(*self.bridge.server_address)
        try:
            return client.request("REGISTER", username=data.get("username"),
                                  password=data.get("password"), full_name=data.get("full_name"))
        finally:
            client.close()

    def login(self):
        data = self._body_json()
        username, password = data.get("username"), data.get("password")
        if not isinstance(username, str) or not isinstance(password, str) or not username.strip():
            raise HttpError(400, "username and password are required")
        session = self.bridge.login(username.strip(), password)
        return {"ok": True, "data": {"token": session.token, "user": session.user,
                                     "peer_port": session.node.port}}

    def logout(self):
        self.bridge.logout(self._token())
        return {"ok": True, "data": "logged out"}

    def status(self):
        """PING the server on this login's connection: online or offline."""
        session = self._session()
        try:
            server = "online" if session.client.request("PING").get("ok") else "offline"
        except (ServerUnavailable, RemoteError):
            server = "offline"
        return {"ok": True, "data": {"server": server, "user": session.user,
                                     "peer_port": session.node.port}}

    # -- records (client-server) -------------------------------------------

    def call(self):
        """Send one client-server request, exactly as the text menu does."""
        session = self._session()
        data = self._body_json()
        action = data.get("action")
        if not isinstance(action, str) or action in RESERVED_ACTIONS:
            raise HttpError(400, "action is not allowed here")
        params = data.get("data") or {}
        if not isinstance(params, dict):
            raise HttpError(400, "data must be a JSON object")
        reply = session.client.request(action, **params)
        if not reply.get("ok"):
            self._json(422, reply)
            return None
        return reply

    # -- peer to peer ------------------------------------------------------

    def peers(self):
        session = self._session()
        directory = session.refresh_directory()
        online = {e["username"]: e for e in directory or []}
        peers = [{"name": name, "host": host, "port": port,
                  "role": online.get(name, {}).get("role"),
                  "online": (name in online) if directory is not None else None}
                 for name, (host, port) in sorted(session.node.peers().items())]
        return {"ok": True, "data": {"server": "online" if directory is not None else "offline",
                                     "peers": peers}}

    def messages(self):
        session = self._session()
        with session._lock:
            history = list(session.history)
        return {"ok": True, "data": history}

    def _known_peer(self, session, name):
        if name not in session.node.peers():
            session.refresh_directory()
        if name not in session.node.peers():
            raise HttpError(404, f"{name} is not in your peer table; the user must be online first")

    def send_message(self):
        session = self._session()
        data = self._body_json()
        to, text = data.get("to"), data.get("text")
        if not isinstance(to, str) or not isinstance(text, str) or not text.strip():
            raise HttpError(400, "to and text are required")
        self._known_peer(session, to)
        session.node.send_chat(to, text)
        entry = session.remember({"direction": "out", "peer": to, "text": text[:2000]})
        return {"ok": True, "data": entry}

    def send_document(self):
        """Body = the file bytes. Send them peer to peer, then record the checksum."""
        session = self._session()
        to = self._param("to")
        claim_no = self._param("claim_no")
        filename = safe_filename(self._param("filename"))
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_FILE_SIZE:
            raise HttpError(413, "file is larger than 50 MB")
        self._known_peer(session, to)

        folder = tempfile.mkdtemp(prefix="esurance-out-")
        path = os.path.join(folder, filename)
        try:
            with open(path, "wb") as f:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        raise HttpError(400, "upload stopped early")
                    f.write(chunk)
                    remaining -= len(chunk)
            sent = session.node.send_file(to, path)
        finally:
            for name in os.listdir(folder):
                os.remove(os.path.join(folder, name))
            os.rmdir(folder)

        record, record_error = None, None
        try:
            record = session.client.call("RECORD_DOCUMENT", claim_no=claim_no, filename=sent["filename"],
                                         size=sent["size"], sha256=sent["sha256"], sent_to=to)
        except ServerUnavailable:
            record_error = "the file was sent, but the server is not available to record the checksum"
        except RemoteError as exc:
            record_error = f"the file was sent, but the checksum was not recorded: {exc}"
        document = {"filename": sent["filename"], "size": sent["size"], "sha256": sent["sha256"]}
        entry = session.remember({"direction": "out", "peer": to, "document": document, "claim_no": claim_no})
        return {"ok": True, "data": {"sent": sent, "recorded": record is not None,
                                     "record_error": record_error, "message": entry}}

    def received(self):
        return {"ok": True, "data": self._session().received_files()}

    def _download(self, name):
        session = self._session()
        if name != os.path.basename(name) or name.startswith("."):
            raise HttpError(404, "not found")
        path = os.path.join(session.inbox, name)
        if not os.path.isfile(path):
            raise HttpError(404, "not found")
        self._send_file(path, attachment=name)

    def events(self):
        """Server-Sent Events: incoming messages and documents, as they arrive."""
        session = self._session()
        q = session.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while not self.bridge._stopping.is_set():
                try:
                    event = q.get(timeout=EVENT_HEARTBEAT_SECONDS)
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                else:
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                    if event.get("type") == "closed":
                        break
                self.wfile.flush()
                session.last_seen = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            session.unsubscribe(q)
        return None

    # -- the built frontend (npm run build) --------------------------------

    def _static(self, path):
        root = self.bridge.static_dir
        if not root or not os.path.isdir(root):
            raise HttpError(404, "no built frontend: run the frontend with npm run dev, or npm run build")
        target = os.path.abspath(os.path.join(root, unquote(path).lstrip("/")))
        if not target.startswith(root + os.sep) or not os.path.isfile(target):
            target = os.path.join(root, "index.html")       # client-side routes
        self._send_file(target)

    def _send_file(self, path, attachment=None):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        if attachment:
            self.send_header("Content-Disposition", f'attachment; filename="{attachment}"')
        self.end_headers()
        with open(path, "rb") as f:
            while chunk := f.read(CHUNK_SIZE):
                self.wfile.write(chunk)

    ROUTES = {
        ("GET", "/api/health"): health,
        ("POST", "/api/register"): register,
        ("POST", "/api/login"): login,
        ("POST", "/api/logout"): logout,
        ("GET", "/api/status"): status,
        ("POST", "/api/call"): call,
        ("GET", "/api/peers"): peers,
        ("GET", "/api/messages"): messages,
        ("POST", "/api/messages"): send_message,
        ("POST", "/api/documents"): send_document,
        ("GET", "/api/received"): received,
        ("GET", "/api/events"): events,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="E-Surance web bridge")
    parser.add_argument("--server", default=f"127.0.0.1:{DEFAULT_SERVER_PORT}",
                        help="server address host:port (default 127.0.0.1:5000)")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address for the browser API (default 127.0.0.1, this computer only)")
    parser.add_argument("--port", type=int, default=DEFAULT_BRIDGE_PORT, help="browser API port (default 8000)")
    parser.add_argument("--peer-port", type=int, default=0,
                        help="first peer port for the logins (default: any free port)")
    parser.add_argument("--data", default=".", help="folder for received/ documents (default: this folder)")
    parser.add_argument("--verbose", action="store_true", help="log every browser request")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    bridge = Bridge(parse_address(args.server), host=args.host, port=args.port,
                    data_dir=args.data, peer_port=args.peer_port).start()
    print(f"E-Surance bridge on http://{args.host}:{bridge.port} for server {args.server}. "
          "Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.shutdown()


if __name__ == "__main__":
    main()
