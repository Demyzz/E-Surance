"""Small text-menu helpers shared by the client menu and the standalone peer.

Incoming peer messages are printed by the listener thread while the user is
typing, so all printing goes through one lock.
"""

import getpass
import sys
import threading

_print_lock = threading.Lock()


def say(text=""):
    with _print_lock:
        print(text, flush=True)


def notify(text):
    """Print a message that arrived from another thread."""
    say(f"\n  >> {text}")


def ask(prompt):
    return input(f"{prompt}: ").strip()


def ask_password(prompt):
    """Hide the password when typing; read a normal line when input is scripted."""
    if sys.stdin.isatty():
        return getpass.getpass(f"{prompt}: ")
    return input(f"{prompt}: ")


def ask_number(prompt, whole=False):
    """Ask until the user types a number, or nothing (returns None)."""
    while True:
        text = ask(prompt).replace(",", "")
        if not text:
            return None
        try:
            return int(text) if whole else float(text)
        except ValueError:
            say("  Type a number, or press Enter to cancel.")


def money(value):
    return f"{value:,.2f}" if isinstance(value, (int, float)) else str(value)


def show_table(rows, columns):
    """Print rows (dicts) as a table. `columns` is a list of (key, header)."""
    if not rows:
        say("  (none)")
        return
    cells = [[_cell(row.get(key)) for key, _ in columns] for row in rows]
    headers = [header for _, header in columns]
    widths = [max(len(h), *(len(r[i]) for r in cells)) for i, h in enumerate(headers)]
    say("  " + "  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    say("  " + "  ".join("-" * w for w in widths))
    for row in cells:
        say("  " + "  ".join(c.ljust(w) for c, w in zip(row, widths)))


def _cell(value):
    if value is None:
        return ""
    if isinstance(value, float):
        return money(value)
    return str(value)


def choose(title, items):
    """Show a numbered menu of (label, function) and run the chosen function.

    Returns False when the user picks 0 (the last item is the exit item).
    """
    say(f"\n=== {title} ===")
    for number, (label, _) in enumerate(items[:-1], start=1):
        say(f"  {number}. {label}")
    say(f"  0. {items[-1][0]}")
    text = ask("Choose")
    if text == "0":
        items[-1][1]()
        return False
    if text.isdigit() and 1 <= int(text) < len(items):
        items[int(text) - 1][1]()
    elif text:
        say("  Type one of the numbers.")
    return True


def choose_peer(node):
    """Let the user pick a peer from the node's peer table."""
    peers = sorted(node.peers().items())
    if not peers:
        say("  No known peers yet.")
        return None
    for number, (name, (host, port)) in enumerate(peers, start=1):
        say(f"  {number}. {name}  ({host}:{port})")
    text = ask("Send to (number or name)")
    if text.isdigit() and 1 <= int(text) <= len(peers):
        return peers[int(text) - 1][0]
    if text in dict(peers):
        return text
    if text:
        say("  Unknown peer.")
    return None
