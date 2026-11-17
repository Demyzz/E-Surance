"""PeerNode: a server and a client in one process.

Server role: a listener thread accepts connections from other peers, and
each incoming request gets a short thread.
Client role: hello(), ask_peers(), send_chat() and send_file() open a short
TCP connection directly to another peer, then close it after the reply.
Peer table: `known_peers` keeps name -> (host, port) for each peer it knows.

Every peer message carries `from` (the sender's name) and `listen_port` (the
port where the sender receives), so the receiver learns the sender.

    HELLO  -> ok {"name"}
    PEERS  -> ok {"name", "peers": {name: [host, port]}}
    CHAT   -> ok "delivered"            (the first 2,000 characters are kept)
    FILE   -> ok "ready", then the raw bytes, then ok {"saved_as", ...} or an error
"""

import hashlib
import logging
import os
import re
import socket
import threading
import uuid

from common.protocol import (
    CHUNK_SIZE,
    ConnectionClosed,
    ProtocolError,
    close_listener,
    error,
    ok,
    recv_message,
    send_message,
    set_reuse,
)

log = logging.getLogger("esurance.peer")

PEER_TIMEOUT = 15                    # seconds; a stopped peer cannot hang a transfer
MAX_FILE_SIZE = 50 * 1024 * 1024     # 50 MB, checked before the transfer starts
MAX_CHAT_LENGTH = 2000
ACCEPT_TIMEOUT = 0.5

_UNSAFE_CHARACTERS = re.compile(r"[^A-Za-z0-9._-]")
_SHA256 = re.compile(r"[0-9a-f]{64}")


class PeerError(Exception):
    """A peer could not be reached, or it refused the request."""


def safe_filename(name):
    """Remove folder parts and unsafe characters: "../../evil.txt" -> "evil.txt"."""
    name = str(name).replace("\\", "/").split("/")[-1]
    name = _UNSAFE_CHARACTERS.sub("_", name).lstrip(".")
    return name[:100] or "file"


def file_checksum(path):
    """Return (size, sha256 hex) of a file, reading it in 64 KB blocks."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _valid_port(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


class PeerNode:
    def __init__(self, name, host="0.0.0.0", port=0, inbox="received",
                 on_chat=None, on_file=None):
        self.name = name
        self.host = host
        self.port = port
        self.inbox = inbox
        self.on_chat = on_chat        # on_chat(sender, text)
        self.on_file = on_file        # on_file(sender, path, size, sha256)
        self.known_peers = {}         # name -> (host, port)
        self._lock = threading.Lock()
        self._file_lock = threading.Lock()
        self._listener = None
        self._thread = None
        self._stopping = threading.Event()

    # -- start and stop ----------------------------------------------------

    def start(self):
        os.makedirs(self.inbox, exist_ok=True)
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        set_reuse(sock)
        sock.bind((self.host, self.port))
        sock.listen()
        sock.settimeout(ACCEPT_TIMEOUT)
        self.port = sock.getsockname()[1]
        self._listener = sock
        self._thread = threading.Thread(target=self._accept_loop, name=f"peer-{self.port}", daemon=True)
        self._thread.start()
        log.info("peer %s listening on port %d", self.name, self.port)
        return self

    def stop(self):
        self._stopping.set()
        if self._listener is not None:
            close_listener(self._listener)
        if self._thread is not None:
            self._thread.join(timeout=2)

    # -- peer table --------------------------------------------------------

    def add_peer(self, name, host, port):
        if not name or name == self.name or not _valid_port(port):
            return False
        with self._lock:
            new = self.known_peers.get(name) != (host, port)
            self.known_peers[name] = (host, port)
        return new

    def peers(self):
        with self._lock:
            return dict(self.known_peers)

    def address(self, peer):
        """`peer` is a name from the peer table, or a (host, port) pair."""
        if isinstance(peer, tuple):
            return peer
        with self._lock:
            if peer not in self.known_peers:
                raise PeerError(f"unknown peer: {peer}")
            return self.known_peers[peer]

    def update_from_directory(self, entries):
        """Add the online users that the server's LIST_PEERS returned."""
        for entry in entries:
            self.add_peer(entry["username"], entry["host"], entry["port"])

    # -- server role -------------------------------------------------------

    def _accept_loop(self):
        while not self._stopping.is_set():
            try:
                conn, address = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn, address), daemon=True).start()

    def _handle(self, conn, address):
        conn.settimeout(PEER_TIMEOUT)
        try:
            try:
                message = recv_message(conn)
            except ProtocolError as exc:
                send_message(conn, error(exc))
                return
            sender = message.get("from")
            listen_port = message.get("listen_port")
            if not isinstance(sender, str) or not sender or not _valid_port(listen_port):
                send_message(conn, error("from and listen_port are required"))
                return
            sender = sender[:50]
            self.add_peer(sender, address[0], listen_port)
            handler = {
                "HELLO": self._on_hello,
                "PEERS": self._on_peers,
                "CHAT": self._on_chat,
                "FILE": self._on_file,
            }.get(message.get("type"))
            if handler is None:
                send_message(conn, error("unknown message type"))
                return
            handler(conn, message, sender)
        except (ConnectionClosed, OSError) as exc:
            log.info("connection from %s ended: %s", address[0], exc)
        finally:
            conn.close()

    def _on_hello(self, conn, message, sender):
        send_message(conn, ok({"name": self.name}))

    def _on_peers(self, conn, message, sender):
        table = {name: list(addr) for name, addr in self.peers().items() if name != sender}
        send_message(conn, ok({"name": self.name, "peers": table}))

    def _on_chat(self, conn, message, sender):
        text = message.get("text")
        if not isinstance(text, str):
            send_message(conn, error("text is required"))
            return
        text = text[:MAX_CHAT_LENGTH]
        self._callback(self.on_chat, sender, text)
        send_message(conn, ok("delivered"))

    def _on_file(self, conn, message, sender):
        filename = message.get("filename")
        size = message.get("size")
        expected = message.get("sha256")
        if not isinstance(filename, str) or not filename:
            send_message(conn, error("filename is required"))
            return
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            send_message(conn, error("size must be a whole number"))
            return
        if size > MAX_FILE_SIZE:
            send_message(conn, error("file is larger than 50 MB"))
            return
        if not isinstance(expected, str) or not _SHA256.fullmatch(expected):
            send_message(conn, error("sha256 must be 64 hexadecimal characters"))
            return

        name = safe_filename(filename)
        part_path = os.path.join(self.inbox, f".{name}.{uuid.uuid4().hex[:8]}.part")
        send_message(conn, ok("ready"))

        # Receive the raw bytes into a .part file, and calculate the checksum
        # at the same time, in one pass.
        digest = hashlib.sha256()
        received = 0
        try:
            with open(part_path, "wb") as f:
                while received < size:
                    chunk = conn.recv(min(CHUNK_SIZE, size - received))
                    if not chunk:
                        raise ConnectionClosed(f"transfer stopped at {received} of {size} bytes")
                    f.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
        except BaseException:
            _remove(part_path)
            raise

        if digest.hexdigest() != expected:
            _remove(part_path)
            log.warning("file %s from %s: checksum does not match, deleted", name, sender)
            send_message(conn, error("checksum does not match; the file was not saved"))
            return

        with self._file_lock:
            final_path = self._free_path(name)
            os.replace(part_path, final_path)
        log.info("file %s from %s saved as %s (%d bytes)", name, sender, final_path, size)
        self._callback(self.on_file, sender, final_path, size, expected)
        send_message(conn, ok({"saved_as": os.path.basename(final_path), "size": size, "sha256": expected}))

    def _free_path(self, name):
        """A new file never replaces an old one: add _1, _2, ... to the name."""
        base, ext = os.path.splitext(name)
        path = os.path.join(self.inbox, name)
        number = 1
        while os.path.exists(path):
            path = os.path.join(self.inbox, f"{base}_{number}{ext}")
            number += 1
        return path

    @staticmethod
    def _callback(function, *args):
        if function is None:
            return
        try:
            function(*args)
        except Exception:
            log.exception("error in peer callback")

    # -- client role -------------------------------------------------------

    def _message(self, kind, **fields):
        return {"type": kind, "from": self.name, "listen_port": self.port, **fields}

    def _connect(self, peer):
        host, port = self.address(peer)
        try:
            return socket.create_connection((host, port), timeout=PEER_TIMEOUT)
        except OSError as exc:
            raise PeerError(f"peer {_label(peer)} is not available ({exc})") from exc

    def _exchange(self, peer, message):
        with self._connect(peer) as sock:
            try:
                send_message(sock, message)
                return _data(recv_message(sock))
            except (ConnectionClosed, ProtocolError, OSError) as exc:
                raise PeerError(f"no reply from peer {_label(peer)} ({exc})") from exc

    def hello(self, host, port):
        """Introduce this node to a peer at host:port; returns the peer's name."""
        data = self._exchange((host, port), self._message("HELLO"))
        name = data["name"]
        self.add_peer(name, host, port)
        return name

    def ask_peers(self, peer):
        """Ask a peer for its peer table; returns the names that were new."""
        data = self._exchange(peer, self._message("PEERS"))
        if isinstance(peer, tuple):
            self.add_peer(data.get("name"), *peer)
        learned = []
        for name, (host, port) in data.get("peers", {}).items():
            if self.add_peer(name, host, port):
                learned.append(name)
        return learned

    def send_chat(self, peer, text):
        return self._exchange(peer, self._message("CHAT", text=text))

    def send_file(self, peer, path):
        """Send a document directly to a peer.

        The checksum is calculated first; the header gives the name, the size
        and the checksum; the bytes follow without JSON.
        """
        size, sha256 = file_checksum(path)
        if size > MAX_FILE_SIZE:
            raise PeerError("file is larger than 50 MB")
        filename = os.path.basename(path)
        with self._connect(peer) as sock:
            try:
                send_message(sock, self._message("FILE", filename=filename, size=size, sha256=sha256))
                _data(recv_message(sock))                     # "ready"
                with open(path, "rb") as f:
                    while chunk := f.read(CHUNK_SIZE):
                        sock.sendall(chunk)
                result = _data(recv_message(sock))
            except (ConnectionClosed, ProtocolError, OSError) as exc:
                raise PeerError(f"transfer to {_label(peer)} failed ({exc})") from exc
        return {"filename": filename, "size": size, "sha256": sha256, "saved_as": result["saved_as"]}


def _data(reply):
    if not reply.get("ok"):
        raise PeerError(reply.get("error", "request refused"))
    return reply.get("data")


def _label(peer):
    return f"{peer[0]}:{peer[1]}" if isinstance(peer, tuple) else peer


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
