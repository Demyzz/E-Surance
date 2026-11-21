"""Text menu for customers, agents, and administrators.

Each menu program is a client of the server and a peer at the same time:

    python -m client.main --server 192.168.1.10:5000

Records (policies, payments, claims) go through the server. Messages and
claim documents go directly to the other user's peer node.

The menu hides the items that a role cannot use, but the server checks the
role of every request again: it does not trust the client.
"""

import argparse
import logging
import os

from client.api import EsuranceClient, RemoteError, ServerUnavailable
from common.console import ask, ask_number, ask_password, choose, choose_peer, money, notify, say, show_table
from common.protocol import DEFAULT_SERVER_PORT, parse_address
from peer.node import PeerError, PeerNode

SERVER_DOWN = ("The server is not available. Messages and documents still work "
               "peer to peer. The next request connects and logs in again.")

POLICY_COLUMNS = [("policy_no", "Policy"), ("policy_type", "Type"), ("customer", "Customer"),
                  ("agent", "Agent"), ("coverage", "Coverage"), ("premium", "Premium"),
                  ("start_date", "Start"), ("end_date", "End"), ("status", "Status")]
PAYMENT_COLUMNS = [("reference", "Reference"), ("policy_no", "Policy"), ("amount", "Amount"),
                   ("paid_by", "Paid by"), ("paid_at", "Date")]
CLAIM_COLUMNS = [("claim_no", "Claim"), ("policy_no", "Policy"), ("customer", "Customer"),
                 ("amount", "Amount"), ("status", "Status"), ("documents", "Docs"),
                 ("filed_at", "Filed"), ("remarks", "Remarks")]
USER_COLUMNS = [("username", "Username"), ("full_name", "Full name"), ("role", "Role"),
                ("created_at", "Created")]
DOCUMENT_COLUMNS = [("filename", "File"), ("size", "Bytes"), ("sha256", "SHA-256"),
                    ("sent_by", "From"), ("sent_to", "To"), ("sent_at", "Date")]
PEER_COLUMNS = [("username", "User"), ("role", "Role"), ("host", "Host"), ("port", "Port")]


class Menu:
    def __init__(self, client, node):
        self.client = client
        self.node = node
        self.running = True

    # -- helpers -----------------------------------------------------------

    def call(self, action, **data):
        """Send one request. Print the error and return None if it fails."""
        try:
            return self.client.call(action, **data)
        except ServerUnavailable:
            say(f"  {SERVER_DOWN}")
        except RemoteError as exc:
            say(f"  Error: {exc}")
        return None

    def done(self, text):
        say(f"  OK: {text}")

    # -- start -------------------------------------------------------------

    def run(self):
        say(f"E-Surance client. Server {self.client.host}:{self.client.port}, "
            f"your peer port {self.node.port}.")
        try:
            while self.running:
                if self.client.user is None:
                    self.start_menu()
                else:
                    self.role_menu()
        except (EOFError, KeyboardInterrupt):
            say()
        finally:
            self.client.close()
            self.node.stop()
            say("Goodbye.")

    def start_menu(self):
        choose("E-Surance", [
            ("Log in", self.login),
            ("Register as a customer", self.register),
            ("Exit", self.exit),
        ])

    def exit(self):
        self.running = False

    def login(self):
        username = ask("Username")
        password = ask_password("Password")
        try:
            reply = self.client.login(username, password, self.node.port)
        except ServerUnavailable:
            say(f"  {SERVER_DOWN}")
            return
        if not reply.get("ok"):
            say(f"  Error: {reply.get('error')}")
            return
        user = reply["data"]
        self.node.name = user["username"]
        say(f"  Welcome, {user['full_name']} ({user['role']}).")
        self.refresh_peers()

    def register(self):
        user = self.call("REGISTER", username=ask("Username (3 to 20 letters, digits, _)"),
                         password=ask_password("Password (6 or more characters)"),
                         full_name=ask("Full name"))
        if user:
            self.done(f"customer account {user['username']} made. You can log in now.")

    def logout(self):
        try:
            self.client.logout()
        except ServerUnavailable:
            pass
        say("  Logged out.")

    # -- role menus --------------------------------------------------------

    def role_menu(self):
        role = self.client.user["role"]
        peer_items = [
            ("Online users (peer directory)", self.show_peers),
            ("Send a message to a user", self.send_message),
            ("Send a claim document to a user", self.send_document),
            ("Documents of a claim", self.show_documents),
        ]
        if role == "customer":
            items = [
                ("My policies", self.show_policies),
                ("Pay a premium", self.pay_premium),
                ("File a claim", self.file_claim),
                ("My claims", self.show_claims),
                ("My payments", self.show_payments),
            ]
        elif role == "agent":
            items = [
                ("Customers", self.show_users),
                ("Create a policy for a customer", self.create_policy),
                ("Record a premium payment", self.pay_premium),
                ("Policies of my customers", self.show_policies),
                ("Claims of my customers", self.show_claims),
                ("Payments of my customers", self.show_payments),
            ]
        else:
            items = [
                ("Create an account", self.create_user),
                ("All users", self.show_users),
                ("All policies", self.show_policies),
                ("All claims", self.show_claims),
                ("Approve or reject a claim", self.decide_claim),
                ("All payments", self.show_payments),
                ("Summary report", self.show_summary),
                ("Create a policy", self.create_policy),
            ]
        user = self.client.user
        choose(f"{user['full_name']} ({role})", items + peer_items + [("Log out", self.logout)])

    # -- records (client-server) -------------------------------------------

    def show_policies(self):
        rows = self.call("LIST_POLICIES")
        if rows is not None:
            show_table(rows, POLICY_COLUMNS)

    def show_payments(self):
        rows = self.call("LIST_PAYMENTS")
        if rows is not None:
            show_table(rows, PAYMENT_COLUMNS)

    def show_claims(self):
        status = ask("Status (PENDING, APPROVED, REJECTED, or Enter for all)").upper() or None
        rows = self.call("LIST_CLAIMS", status=status)
        if rows is not None:
            show_table(rows, CLAIM_COLUMNS)

    def show_users(self):
        role = None
        if self.client.user["role"] == "admin":
            role = ask("Role (customer, agent, admin, or Enter for all)").lower() or None
        rows = self.call("LIST_USERS", role=role)
        if rows is not None:
            show_table(rows, USER_COLUMNS)

    def create_user(self):
        user = self.call("CREATE_USER", username=ask("Username"),
                         password=ask_password("Password"),
                         full_name=ask("Full name"), role=ask("Role (customer, agent, admin)"))
        if user:
            self.done(f"{user['role']} account {user['username']} made")

    def create_policy(self):
        customer = ask("Customer username")
        policy_type = ask("Policy type (LIFE, HEALTH, MOTOR, PROPERTY)")
        coverage = ask_number("Coverage")
        premium = ask_number("Premium")
        term = ask_number("Term in months (1 to 600)", whole=True)
        if None in (coverage, premium, term):
            say("  Cancelled.")
            return
        policy = self.call("CREATE_POLICY", customer=customer, policy_type=policy_type,
                           coverage=coverage, premium=premium, term_months=term)
        if policy:
            self.done(f"policy {policy['policy_no']} for {policy['customer']}, "
                      f"{policy['start_date']} to {policy['end_date']}")

    def pay_premium(self):
        policy_no = ask("Policy number")
        amount = ask_number("Amount")
        if amount is None:
            say("  Cancelled.")
            return
        payment = self.call("PAY_PREMIUM", policy_no=policy_no, amount=amount)
        if payment:
            self.done(f"payment {payment['reference']} of {money(payment['amount'])}")

    def file_claim(self):
        policy_no = ask("Policy number")
        description = ask("Description")
        amount = ask_number("Amount")
        if amount is None:
            say("  Cancelled.")
            return
        claim = self.call("FILE_CLAIM", policy_no=policy_no, description=description, amount=amount)
        if claim:
            self.done(f"claim {claim['claim_no']} is {claim['status']}. "
                      "You can now send a document to your agent.")

    def decide_claim(self):
        claim_no = ask("Claim number")
        decision = ask("Decision (APPROVED or REJECTED)")
        remarks = ask("Remarks") or None
        claim = self.call("DECIDE_CLAIM", claim_no=claim_no, decision=decision, remarks=remarks)
        if claim:
            self.done(f"claim {claim['claim_no']} is {claim['status']}")

    def show_summary(self):
        report = self.call("SUMMARY")
        if report is None:
            return
        users, policies = report["users"], report["policies"]
        payments, claims = report["payments"], report["claims"]
        say(f"  Users:     {users['customer']} customers, {users['agent']} agents, "
            f"{users['admin']} administrators")
        say(f"  Policies:  {policies['count']} ({policies['active']} active), "
            f"total coverage {money(policies['total_coverage'])}")
        say(f"  Payments:  {payments['count']}, total {money(payments['total'])}")
        say(f"  Claims:    {claims['PENDING']} pending, {claims['APPROVED']} approved, "
            f"{claims['REJECTED']} rejected; claimed {money(claims['total_claimed'])}, "
            f"approved {money(claims['total_approved'])}")
        say(f"  Documents: {report['documents']} recorded")

    def show_documents(self):
        rows = self.call("LIST_DOCUMENTS", claim_no=ask("Claim number"))
        if rows is not None:
            show_table(rows, DOCUMENT_COLUMNS)

    # -- peer to peer ------------------------------------------------------

    def refresh_peers(self):
        """Ask the server directory where the online users are."""
        try:
            entries = self.client.call("LIST_PEERS")
        except (ServerUnavailable, RemoteError):
            return None
        self.node.update_from_directory(entries)
        return entries

    def show_peers(self):
        entries = self.refresh_peers()
        if entries is None:
            say(f"  {SERVER_DOWN}")
            say("  Peers in your peer table:")
            entries = [{"username": n, "host": h, "port": p} for n, (h, p) in sorted(self.node.peers().items())]
        show_table(entries, PEER_COLUMNS)

    def send_message(self):
        self.refresh_peers()
        peer = choose_peer(self.node)
        if peer is None:
            return
        text = ask("Message")
        try:
            self.node.send_chat(peer, text)
            self.done(f"delivered to {peer} directly")
        except PeerError as exc:
            say(f"  Error: {exc}")

    def send_document(self):
        """Send the file peer to peer, then record its checksum on the claim."""
        claim_no = ask("Claim number")
        path = ask("File path")
        if not os.path.isfile(path):
            say("  Error: file not found")
            return
        self.refresh_peers()
        peer = choose_peer(self.node)
        if peer is None:
            return
        try:
            sent = self.node.send_file(peer, path)
        except PeerError as exc:
            say(f"  Error: {exc}")
            return
        self.done(f"{sent['filename']} ({sent['size']:,} bytes) sent directly to {peer}; "
                  f"SHA-256 {sent['sha256']}")
        record = self.call("RECORD_DOCUMENT", claim_no=claim_no, filename=sent["filename"],
                           size=sent["size"], sha256=sent["sha256"], sent_to=peer)
        if record:
            self.done(f"checksum recorded on claim {claim_no}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="E-Surance client menu")
    parser.add_argument("--server", default=f"127.0.0.1:{DEFAULT_SERVER_PORT}",
                        help="server address host:port (default 127.0.0.1:5000)")
    parser.add_argument("--peer-port", type=int, default=0,
                        help="port where this client receives peer messages (default: any free port)")
    parser.add_argument("--inbox", default="received", help="folder for received documents")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    host, port = parse_address(args.server)
    node = PeerNode(
        name=None, port=args.peer_port, inbox=args.inbox,
        on_chat=lambda sender, text: notify(f"message from {sender}: {text}"),
        on_file=lambda sender, path, size, sha256: notify(
            f"document from {sender} saved as {path} ({size:,} bytes, SHA-256 {sha256})"),
    ).start()
    Menu(EsuranceClient(host, port), node).run()


if __name__ == "__main__":
    main()
