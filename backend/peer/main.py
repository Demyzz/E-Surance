"""Standalone peer (for example a branch office). It does not use the server.

    python -m peer.main --name alpha --port 6001
    python -m peer.main --name beta  --port 6002 --connect 192.168.1.10:6001

With --connect, the new peer says HELLO to one known peer, then asks it for
its PEERS, and so learns the other peers without any central server.
"""

import argparse
import logging
import os

from common.console import ask, choose, choose_peer, notify, say, show_table
from common.protocol import parse_address
from peer.node import PeerError, PeerNode


class PeerMenu:
    def __init__(self, node):
        self.node = node
        self.running = True

    def run(self):
        say(f"Peer {self.node.name} on port {self.node.port}. Documents go to {self.node.inbox}/.")
        try:
            while self.running:
                choose(f"Peer {self.node.name}", [
                    ("Peer table", self.show_peers),
                    ("Connect to a peer (host:port)", self.connect),
                    ("Ask a peer for its peers", self.ask_peers),
                    ("Send a message", self.send_message),
                    ("Send a file", self.send_file),
                    ("Exit", self.exit),
                ])
        except (EOFError, KeyboardInterrupt):
            say()
        finally:
            self.node.stop()
            say("Goodbye.")

    def exit(self):
        self.running = False

    def show_peers(self):
        rows = [{"name": n, "host": h, "port": p} for n, (h, p) in sorted(self.node.peers().items())]
        show_table(rows, [("name", "Peer"), ("host", "Host"), ("port", "Port")])

    def connect(self, address=None):
        address = address or ask("Peer address (host:port)")
        try:
            host, port = parse_address(address, default_port=0)
            name = self.node.hello(host, port)
            learned = self.node.ask_peers(name)
        except (PeerError, ValueError) as exc:
            say(f"  Error: {exc}")
            return
        say(f"  OK: connected to {name}" + (f"; learned {', '.join(learned)}" if learned else ""))

    def ask_peers(self):
        peer = choose_peer(self.node)
        if peer is None:
            return
        try:
            learned = self.node.ask_peers(peer)
        except PeerError as exc:
            say(f"  Error: {exc}")
            return
        say(f"  OK: learned {', '.join(learned)}" if learned else "  No new peers.")

    def send_message(self):
        peer = choose_peer(self.node)
        if peer is None:
            return
        try:
            self.node.send_chat(peer, ask("Message"))
            say(f"  OK: delivered to {peer}")
        except PeerError as exc:
            say(f"  Error: {exc}")

    def send_file(self):
        peer = choose_peer(self.node)
        if peer is None:
            return
        path = ask("File path")
        if not os.path.isfile(path):
            say("  Error: file not found")
            return
        try:
            sent = self.node.send_file(peer, path)
        except PeerError as exc:
            say(f"  Error: {exc}")
            return
        say(f"  OK: {sent['filename']} ({sent['size']:,} bytes) saved by {peer} as "
            f"{sent['saved_as']}; SHA-256 {sent['sha256']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="E-Surance standalone peer")
    parser.add_argument("--name", required=True, help="the name of this peer")
    parser.add_argument("--port", type=int, default=0, help="listen port (default: any free port)")
    parser.add_argument("--connect", help="address host:port of one known peer")
    parser.add_argument("--inbox", default="received", help="folder for received files")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    node = PeerNode(
        args.name, port=args.port, inbox=args.inbox,
        on_chat=lambda sender, text: notify(f"message from {sender}: {text}"),
        on_file=lambda sender, path, size, sha256: notify(
            f"file from {sender} saved as {path} ({size:,} bytes, SHA-256 {sha256})"),
    ).start()
    menu = PeerMenu(node)
    if args.connect:
        menu.connect(args.connect)
    menu.run()


if __name__ == "__main__":
    main()
