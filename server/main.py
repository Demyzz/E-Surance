"""Network layer: accept TCP connections, one thread for each client.

Run from the project folder:

    python -m server.main                 # port 5000, database esurance.db
    python -m server.main --port 5001 --db test.db

The main thread accepts connections. The accept call has a 0.5-second
timeout, so the main thread can see Ctrl+C and stop.
"""

import argparse
import logging
import socket
import threading

from common.protocol import (
    DEFAULT_SERVER_PORT,
    ConnectionClosed,
    MessageTooLarge,
    ProtocolError,
    close_listener,
    error,
    recv_message,
    send_message,
    set_reuse,
)
from server.database import Database
from server.handlers import Service, Session

log = logging.getLogger("esurance.server")

ACCEPT_TIMEOUT = 0.5


class EsuranceServer:
    def __init__(self, host="0.0.0.0", port=DEFAULT_SERVER_PORT, db_path="esurance.db"):
        self.host = host
        self.port = port
        self.db = Database(db_path)
        self.service = Service(self.db)
        self._listener = None
        self._accept_thread = None
        self._stopping = threading.Event()
        self._connections = set()
        self._connections_lock = threading.Lock()

    # -- start and stop ----------------------------------------------------

    def _listen(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        set_reuse(sock)
        sock.bind((self.host, self.port))
        sock.listen()
        sock.settimeout(ACCEPT_TIMEOUT)
        self.port = sock.getsockname()[1]   # the real port when port 0 was asked
        self._listener = sock
        log.info("listening on %s:%d, database %s", self.host, self.port, self.db.path)

    def start(self):
        """Accept in a background thread (used by the tests)."""
        self._listen()
        self._accept_thread = threading.Thread(target=self._accept_loop, name="accept", daemon=True)
        self._accept_thread.start()
        return self

    def serve_forever(self):
        """Accept in the main thread until Ctrl+C."""
        self._listen()
        try:
            self._accept_loop()
        except KeyboardInterrupt:
            log.info("Ctrl+C: stopping")
        finally:
            self.shutdown()

    def shutdown(self):
        """Close the listen socket and every client socket.

        Each client then finds the failure at its next request, and does not
        wait for a timeout.
        """
        self._stopping.set()
        if self._listener is not None:
            close_listener(self._listener)
        with self._connections_lock:
            connections = list(self._connections)
            self._connections.clear()
        for conn in connections:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()
        if self._accept_thread is not None and self._accept_thread is not threading.current_thread():
            self._accept_thread.join(timeout=2)
        self.db.close()
        log.info("server stopped")

    # -- connections -------------------------------------------------------

    def _accept_loop(self):
        while not self._stopping.is_set():
            try:
                conn, address = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break   # the listen socket was closed
            conn.settimeout(None)
            with self._connections_lock:
                if self._stopping.is_set():
                    conn.close()
                    break
                self._connections.add(conn)
            threading.Thread(
                target=self._serve_client, args=(conn, address),
                name=f"client-{address[0]}:{address[1]}", daemon=True,
            ).start()

    def _serve_client(self, conn, address):
        """Read a request, send the reply, repeat, until the client leaves."""
        session = Session(address)
        log.info("connection from %s:%d", address[0], address[1])
        try:
            while True:
                try:
                    message = recv_message(conn)
                except MessageTooLarge as exc:
                    send_message(conn, error(exc))
                    break
                except ProtocolError as exc:
                    send_message(conn, error(exc))
                    continue
                log.debug("%s: %s", session.user and session.user["username"], message.get("action"))
                send_message(conn, self.service.handle(session, message))
        except (ConnectionClosed, OSError):
            pass
        finally:
            self.service.disconnect(session)
            with self._connections_lock:
                self._connections.discard(conn)
            conn.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="E-Surance server")
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=DEFAULT_SERVER_PORT, help="TCP port (default 5000)")
    parser.add_argument("--db", default="esurance.db", help="SQLite database file (default esurance.db)")
    parser.add_argument("--verbose", action="store_true", help="log every request")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    server = EsuranceServer(args.host, args.port, args.db)
    print(f"E-Surance server on port {server.port}. Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
