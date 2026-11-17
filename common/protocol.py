"""Message format shared by the server, the client, and the peer node.

Each message is a 4-byte length header (unsigned, big-endian) followed by a
JSON body in UTF-8. The receiver reads the 4 bytes first, then exactly that
number of bytes, so TCP's stream of bytes is cut back into whole messages.

    +--------------------------+----------------------------------+
    | length: 4 bytes          | body: JSON text, UTF-8           |
    | unsigned, big-endian     | 1 MB maximum                     |
    +--------------------------+----------------------------------+

Client-server request:  {"action": "PAY_PREMIUM", "data": {...}}
Peer-to-peer request:   {"type": "CHAT", "from": "...", "listen_port": 6001, ...}
Reply (both):           {"ok": true, "data": ...}  or  {"ok": false, "error": "..."}
"""

import json
import socket
import struct

DEFAULT_SERVER_PORT = 5000
MAX_MESSAGE_SIZE = 1024 * 1024          # 1 MB for one JSON message
CHUNK_SIZE = 64 * 1024                  # file bytes move in 64 KB blocks

_HEADER = struct.Struct("!I")


class ProtocolError(Exception):
    """The other side sent bytes that are not a valid message."""


class MessageTooLarge(ProtocolError):
    """The header announced more than 1 MB. The body was not read, so the
    stream is no longer in step and the connection must close."""


class ConnectionClosed(ConnectionError):
    """The other side closed the connection."""


def encode_message(message):
    """Return the bytes for one message: length header + JSON body."""
    if not isinstance(message, dict):
        raise ProtocolError("a message must be a JSON object")
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_MESSAGE_SIZE:
        raise ProtocolError("message is larger than 1 MB")
    return _HEADER.pack(len(body)) + body


def send_message(sock, message):
    sock.sendall(encode_message(message))


def recv_exact(sock, count):
    """Read exactly `count` bytes, or raise ConnectionClosed."""
    parts = []
    remaining = count
    while remaining:
        chunk = sock.recv(min(remaining, CHUNK_SIZE))
        if not chunk:
            raise ConnectionClosed("connection closed by the other side")
        parts.append(chunk)
        remaining -= len(chunk)
    return b"".join(parts)


def recv_message(sock):
    """Read one whole message and return it as a dict."""
    (length,) = _HEADER.unpack(recv_exact(sock, _HEADER.size))
    if length > MAX_MESSAGE_SIZE:
        raise MessageTooLarge("message is larger than 1 MB")
    body = recv_exact(sock, length)
    try:
        message = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("message is not valid JSON") from exc
    if not isinstance(message, dict):
        raise ProtocolError("a message must be a JSON object")
    return message


def ok(data=None):
    return {"ok": True, "data": data}


def error(text):
    return {"ok": False, "error": str(text)}


def request(action, **data):
    return {"action": action, "data": data}


def parse_address(text, default_port=DEFAULT_SERVER_PORT):
    """Turn "host:port" (or "host") into (host, port)."""
    host, sep, port = text.rpartition(":")
    if not sep:
        return text, default_port
    return host or "127.0.0.1", int(port)


def set_reuse(sock):
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)


def close_listener(sock):
    """Close a listen socket and wake a thread that waits in accept().

    shutdown() wakes accept() at once on Linux; on other systems the accept
    timeout (0.5 s) ends the wait.
    """
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    sock.close()
