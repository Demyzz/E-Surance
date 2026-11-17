"""The 16 automated tests. Run from the backend folder:

    python -m unittest -v

Each test starts a real server and real peers on free local ports, with a
temporary database.
"""

import hashlib
import logging
import os
import re
import shutil
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing

from client.api import EsuranceClient, ServerUnavailable
from common.protocol import recv_message, send_message
from peer.node import PeerNode, safe_filename
from server.main import EsuranceServer

ADMIN = ("admin", "admin123")
AGENT = ("agent", "agent123")


def setUpModule():
    logging.getLogger("esurance").setLevel(logging.CRITICAL)


def wait_for(condition, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def sha256_of(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class ESuranceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="esurance-test-")
        self.db_path = os.path.join(self.tmp, "esurance.db")
        self.server = EsuranceServer("127.0.0.1", 0, self.db_path).start()
        self._clients = []
        self._nodes = []

    def tearDown(self):
        for client in self._clients:
            try:
                client.close()
            except Exception:
                pass
        for node in self._nodes:
            node.stop()
        if self.server is not None:
            self.server.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers -----------------------------------------------------------

    def client(self):
        client = EsuranceClient("127.0.0.1", self.server.port)
        self._clients.append(client)
        return client

    def login(self, username, password, p2p_port=None):
        client = self.client()
        reply = client.login(username, password, p2p_port)
        self.assertTrue(reply["ok"], reply)
        return client

    def customer(self, username, p2p_port=None):
        reply = self.client().request("REGISTER", username=username, password="secret1",
                                      full_name=username.title())
        self.assertTrue(reply["ok"], reply)
        return self.login(username, "secret1", p2p_port)

    def node(self, name):
        node = PeerNode(name, host="127.0.0.1", inbox=os.path.join(self.tmp, f"inbox-{name}")).start()
        self._nodes.append(node)
        return node

    def policy(self, agent, customer, coverage=500_000, premium=1_200, term_months=12):
        return agent.call("CREATE_POLICY", customer=customer, policy_type="LIFE",
                          coverage=coverage, premium=premium, term_months=term_months)

    def file_of(self, name, size):
        folder = tempfile.mkdtemp(dir=self.tmp)       # a new folder, so a same-name file is a new file
        path = os.path.join(folder, name)
        with open(path, "wb") as f:
            f.write(os.urandom(size))
        return path

    def assertError(self, reply, text):
        self.assertFalse(reply["ok"], reply)
        self.assertIn(text, reply["error"])

    # -- 1 to 8: client-server ---------------------------------------------

    def test_01_login_is_necessary(self):
        client = self.client()
        self.assertEqual(client.request("PING"), {"ok": True, "data": "pong"})
        self.assertError(client.request("LIST_POLICIES"), "log in first")
        self.assertError(client.request("PAY_PREMIUM", policy_no="POL-2026-0001", amount=1), "log in first")

    def test_02_register_and_log_in(self):
        client = self.client()
        reply = client.request("REGISTER", username="juan", password="secret1",
                               full_name="Juan Dela Cruz", role="admin")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["data"]["role"], "customer")      # REGISTER makes customers only
        self.assertError(client.request("REGISTER", username="juan", password="other12",
                                        full_name="Other"), "username already exists")
        self.assertError(client.request("LOGIN", username="juan", password="wrong12"),
                         "wrong username or password")
        self.assertError(client.request("REGISTER", username="ab", password="secret1",
                                        full_name="Too Short"), "username")
        self.assertError(client.request("REGISTER", username="pedro", password="123",
                                        full_name="Short Password"), "password")
        self.assertEqual(client.login("juan", "secret1")["data"]["role"], "customer")

    def test_03_password_storage(self):
        self.customer("juan")
        with closing(sqlite3.connect(self.db_path)) as conn:
            password_hash, salt = conn.execute(
                "SELECT password_hash, salt FROM users WHERE username = 'juan'").fetchone()
        self.assertEqual(len(password_hash), 64)
        self.assertRegex(password_hash, r"^[0-9a-f]{64}$")
        self.assertEqual(len(salt), 32)                            # 16 random bytes
        self.assertNotIn("secret1", password_hash + salt)

    def test_04_roles(self):
        juan = self.customer("juan")
        agent = self.login(*AGENT)
        self.assertError(juan.request("CREATE_POLICY", customer="juan", policy_type="LIFE",
                                      coverage=1000, premium=10, term_months=12), "permission denied")
        self.assertError(juan.request("SUMMARY"), "permission denied")
        self.assertError(agent.request("DECIDE_CLAIM", claim_no="CLM-2026-0001",
                                       decision="APPROVED"), "permission denied")
        self.assertError(agent.request("CREATE_USER", username="boss", password="secret1",
                                       full_name="Boss", role="admin"), "permission denied")

    def test_05_full_insurance_flow(self):
        juan = self.customer("juan")
        agent = self.login(*AGENT)
        admin = self.login(*ADMIN)

        policy = self.policy(agent, "juan")
        self.assertRegex(policy["policy_no"], r"^POL-\d{4}-\d{4}$")
        self.assertEqual((policy["status"], policy["customer"], policy["agent"]), ("ACTIVE", "juan", "agent"))

        payment = juan.call("PAY_PREMIUM", policy_no=policy["policy_no"], amount=1200)
        self.assertRegex(payment["reference"], r"^PAY-\d{4}-\d{4}$")
        self.assertEqual(payment["amount"], 1200.0)

        claim = juan.call("FILE_CLAIM", policy_no=policy["policy_no"],
                          description="Hospital confinement", amount=45_000)
        self.assertRegex(claim["claim_no"], r"^CLM-\d{4}-\d{4}$")
        self.assertEqual(claim["status"], "PENDING")

        decided = admin.call("DECIDE_CLAIM", claim_no=claim["claim_no"], decision="APPROVED",
                             remarks="Documents complete")
        self.assertEqual((decided["status"], decided["decided_by"]), ("APPROVED", "admin"))
        self.assertError(admin.request("DECIDE_CLAIM", claim_no=claim["claim_no"], decision="REJECTED"),
                         "claim already has a decision")

        self.assertEqual(juan.call("LIST_CLAIMS")[0]["status"], "APPROVED")
        report = admin.call("SUMMARY")
        self.assertEqual(report["policies"]["count"], 1)
        self.assertEqual(report["payments"], {"count": 1, "total": 1200.0})
        self.assertEqual(report["claims"]["APPROVED"], 1)
        self.assertEqual(report["claims"]["total_approved"], 45_000.0)

    def test_06_scope(self):
        juan = self.customer("juan")
        maria = self.customer("maria")
        agent = self.login(*AGENT)
        policy_no = self.policy(agent, "juan")["policy_no"]
        claim_no = juan.call("FILE_CLAIM", policy_no=policy_no, description="Accident", amount=1000)["claim_no"]

        self.assertEqual(maria.call("LIST_POLICIES"), [])
        self.assertEqual(maria.call("LIST_CLAIMS"), [])
        self.assertError(maria.request("PAY_PREMIUM", policy_no=policy_no, amount=1200), "policy not found")
        self.assertError(maria.request("FILE_CLAIM", policy_no=policy_no, description="Not mine",
                                       amount=10), "policy not found")
        self.assertError(maria.request("LIST_DOCUMENTS", claim_no=claim_no), "claim not found")
        self.assertEqual([p["policy_no"] for p in juan.call("LIST_POLICIES")], [policy_no])
        self.assertEqual([p["policy_no"] for p in agent.call("LIST_POLICIES")], [policy_no])

    def test_07_bad_input(self):
        juan = self.customer("juan")
        agent = self.login(*AGENT)
        self.assertError(agent.request("CREATE_POLICY", customer="juan", policy_type="BOAT",
                                       coverage=1000, premium=10, term_months=12), "policy_type")
        self.assertError(agent.request("CREATE_POLICY", customer="nobody", policy_type="LIFE",
                                       coverage=1000, premium=10, term_months=12), "customer not found")
        self.assertError(agent.request("CREATE_POLICY", customer="juan", policy_type="LIFE",
                                       coverage=1000, premium=1000, term_months=12), "premium")
        self.assertError(agent.request("CREATE_POLICY", customer="juan", policy_type="LIFE",
                                       coverage=1000, premium=10, term_months=601), "term_months")
        policy_no = self.policy(agent, "juan", coverage=10_000, premium=100)["policy_no"]
        self.assertError(juan.request("PAY_PREMIUM", policy_no=policy_no, amount="abc"),
                         "amount must be a number")
        self.assertError(juan.request("PAY_PREMIUM", policy_no=policy_no, amount=-5), "more than zero")
        self.assertError(juan.request("FILE_CLAIM", policy_no=policy_no, description="Too much",
                                      amount=20_000), "more than the coverage")
        self.assertError(juan.request("FLY_TO_THE_MOON"), "unknown action")

    def test_08_many_clients(self):
        self.customer("juan")
        policy_no = self.policy(self.login(*AGENT), "juan")["policy_no"]
        clients = [self.login("juan", "secret1") for _ in range(20)]
        references, failures = [], []
        lock = threading.Lock()

        def pay(client):
            for _ in range(10):
                reply = client.request("PAY_PREMIUM", policy_no=policy_no, amount=100)
                with lock:
                    (references if reply["ok"] else failures).append(reply)

        threads = [threading.Thread(target=pay, args=(c,)) for c in clients]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(failures, [])
        self.assertEqual(len(references), 200)
        self.assertEqual(len({r["data"]["reference"] for r in references}), 200)
        self.assertEqual(len(clients[0].call("LIST_PAYMENTS")), 200)

    # -- 9 to 14: peer-to-peer ---------------------------------------------

    def test_09_peer_directory(self):
        juan = self.customer("juan", p2p_port=7001)
        # maria logs in on a raw socket, then the connection drops without LOGOUT
        self.client().request("REGISTER", username="maria", password="secret1", full_name="Maria")
        raw = socket.create_connection(("127.0.0.1", self.server.port))
        send_message(raw, {"action": "LOGIN", "data": {"username": "maria", "password": "secret1",
                                                      "p2p_port": 7002}})
        self.assertTrue(recv_message(raw)["ok"])

        peers = juan.call("LIST_PEERS")
        self.assertEqual(peers, [{"username": "maria", "host": "127.0.0.1", "port": 7002, "role": "customer"}])
        raw.close()
        self.assertTrue(wait_for(lambda: juan.call("LIST_PEERS") == []))

    def test_10_peer_message(self):
        alpha, beta = self.node("alpha"), self.node("beta")
        inbox = []
        beta.on_chat = lambda sender, text: inbox.append((sender, text))
        alpha.add_peer("beta", "127.0.0.1", beta.port)

        self.assertEqual(alpha.send_chat("beta", "Hello, I filed a claim."), "delivered")
        self.assertEqual(inbox, [("alpha", "Hello, I filed a claim.")])
        self.assertEqual(beta.peers()["alpha"], ("127.0.0.1", alpha.port))   # learned the sender
        alpha.send_chat("beta", "x" * 2500)
        self.assertEqual(len(inbox[1][1]), 2000)

    def test_11_peer_file_transfer(self):
        alpha, beta = self.node("alpha"), self.node("beta")
        alpha.add_peer("beta", "127.0.0.1", beta.port)
        first = self.file_of("report.bin", 300_000)
        sent = alpha.send_file("beta", first)
        self.assertEqual(sent["saved_as"], "report.bin")
        received = os.path.join(beta.inbox, "report.bin")
        with open(first, "rb") as a, open(received, "rb") as b:
            self.assertEqual(a.read(), b.read())

        second = self.file_of("report.bin", 1_000)           # same name, other bytes
        self.assertEqual(alpha.send_file("beta", second)["saved_as"], "report_1.bin")
        self.assertEqual(sha256_of(received), sha256_of(first))   # the first file is unchanged
        self.assertEqual(sha256_of(os.path.join(beta.inbox, "report_1.bin")), sha256_of(second))

    def test_12_changed_file(self):
        beta = self.node("beta")
        data = os.urandom(10_000)
        wrong = hashlib.sha256(b"something else").hexdigest()
        with socket.create_connection(("127.0.0.1", beta.port)) as sock:
            send_message(sock, {"type": "FILE", "from": "mallory", "listen_port": 9,
                                "filename": "../../evil.txt", "size": len(data), "sha256": wrong})
            self.assertEqual(recv_message(sock), {"ok": True, "data": "ready"})
            sock.sendall(data)
            reply = recv_message(sock)
        self.assertFalse(reply["ok"])
        self.assertIn("checksum", reply["error"])
        self.assertEqual(os.listdir(beta.inbox), [])                       # no file, no .part
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil.txt")))
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.tmp), "evil.txt")))
        self.assertEqual(safe_filename("../../evil.txt"), "evil.txt")
        self.assertEqual(safe_filename("..\\..\\bad name?.pdf"), "bad_name_.pdf")

    def test_13_discovery_without_the_server(self):
        alpha, beta, gamma = self.node("alpha"), self.node("beta"), self.node("gamma")
        self.assertEqual(beta.hello("127.0.0.1", alpha.port), "alpha")      # alpha learns beta
        self.assertEqual(gamma.hello("127.0.0.1", alpha.port), "alpha")
        self.assertIn("beta", gamma.ask_peers("alpha"))                     # gamma learns beta from alpha
        self.assertEqual(gamma.peers()["beta"], ("127.0.0.1", beta.port))
        self.assertEqual(gamma.send_chat("beta", "hi from gamma"), "delivered")

    def test_14_peers_without_the_server(self):
        self.server.shutdown()
        self.server = None
        alpha, beta = self.node("alpha"), self.node("beta")
        got_alpha, got_beta = [], []
        alpha.on_chat = lambda sender, text: got_alpha.append((sender, text))
        beta.on_chat = lambda sender, text: got_beta.append((sender, text))
        alpha.hello("127.0.0.1", beta.port)
        alpha.send_chat("beta", "ping")
        beta.send_chat("alpha", "pong")     # beta learned alpha's address from the message
        self.assertEqual(got_beta, [("alpha", "ping")])
        self.assertEqual(got_alpha, [("beta", "pong")])

    # -- 15 and 16: the two models together --------------------------------

    def test_15_hybrid_document_flow(self):
        juan_node, agent_node = self.node("juan"), self.node("agent")
        juan = self.customer("juan", p2p_port=juan_node.port)
        agent = self.login(*AGENT, p2p_port=agent_node.port)
        policy_no = self.policy(agent, "juan")["policy_no"]
        claim_no = juan.call("FILE_CLAIM", policy_no=policy_no, description="Hospital", amount=45_000)["claim_no"]

        # 1-2: the server is only the directory
        directory = juan.call("LIST_PEERS")
        self.assertEqual([(p["username"], p["port"]) for p in directory], [("agent", agent_node.port)])
        juan_node.update_from_directory(directory)
        # 3-7: the file goes directly to the agent's peer node
        sent = juan_node.send_file("agent", self.file_of("medical_report.pdf", 150_000))
        # 8-9: the server keeps only the name, the size, and the checksum
        juan.call("RECORD_DOCUMENT", claim_no=claim_no, filename=sent["filename"], size=sent["size"],
                  sha256=sent["sha256"], sent_to="agent")

        documents = agent.call("LIST_DOCUMENTS", claim_no=claim_no)
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0]["sha256"], sent["sha256"])
        self.assertEqual(sha256_of(os.path.join(agent_node.inbox, "medical_report.pdf")), sent["sha256"])
        self.assertEqual(agent.call("LIST_CLAIMS")[0]["documents"], 1)

    def test_16_server_crash_and_recovery(self):
        juan_node, agent_node = self.node("juan"), self.node("agent")
        juan = self.customer("juan", p2p_port=juan_node.port)
        policy_no = self.policy(self.login(*AGENT, p2p_port=agent_node.port), "juan")["policy_no"]
        juan_node.update_from_directory(juan.call("LIST_PEERS"))
        messages = []
        agent_node.on_chat = lambda sender, text: messages.append(text)
        port = self.server.port

        self.server.shutdown()
        self.server = None
        with self.assertRaises(ServerUnavailable):                 # (a) the client detects the stop
            juan.request("LIST_POLICIES")
        with self.assertRaises(ServerUnavailable):
            juan.request("LIST_POLICIES")
        self.assertEqual(juan_node.send_chat("agent", "still here"), "delivered")   # (b) peers continue
        self.assertEqual(messages, ["still here"])

        self.server = EsuranceServer("127.0.0.1", port, self.db_path).start()
        policies = juan.call("LIST_POLICIES")                       # (c) logs in again by itself
        self.assertEqual([p["policy_no"] for p in policies], [policy_no])
        self.assertEqual(juan.user["username"], "juan")


if __name__ == "__main__":
    unittest.main()
