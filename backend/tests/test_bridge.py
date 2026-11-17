"""Tests for the web bridge that the browser frontend uses.

Each test starts a real server and a real bridge on free local ports. The
tests talk to the bridge over HTTP, the same way the browser does.
"""

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from bridge import Bridge
from server.main import EsuranceServer

# Talk to 127.0.0.1 directly, never through a proxy from the environment.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def setUpModule():
    logging.getLogger("esurance").setLevel(logging.CRITICAL)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="esurance-bridge-")
        self.server = EsuranceServer("127.0.0.1", 0, os.path.join(self.tmp, "esurance.db")).start()
        self.bridge = Bridge(("127.0.0.1", self.server.port), host="127.0.0.1", port=0,
                             data_dir=self.tmp, static_dir=None, peer_host="127.0.0.1").start()

    def tearDown(self):
        self.bridge.shutdown()
        if self.server is not None:
            self.server.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers -----------------------------------------------------------

    def http(self, method, path, body=None, token=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(f"http://127.0.0.1:{self.bridge.port}{path}", data=data, method=method)
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with _opener.open(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def login(self, username, password):
        status, reply = self.http("POST", "/api/login", {"username": username, "password": password})
        self.assertEqual(status, 200, reply)
        return reply["data"]["token"]

    def call(self, token, action, **data):
        status, reply = self.http("POST", "/api/call", {"action": action, "data": data}, token)
        self.assertEqual(status, 200, reply)
        return reply["data"]

    def register_juan(self):
        status, reply = self.http("POST", "/api/register",
                                  {"username": "juan", "password": "secret1", "full_name": "Juan Dela Cruz"})
        self.assertEqual(status, 200, reply)
        return self.login("juan", "secret1")

    # -- tests -------------------------------------------------------------

    def test_login_and_records(self):
        juan = self.register_juan()
        agent = self.login("agent", "agent123")
        policy = self.call(agent, "CREATE_POLICY", customer="juan", policy_type="HEALTH",
                           coverage=200_000, premium=900, term_months=12)
        self.assertEqual([p["policy_no"] for p in self.call(juan, "LIST_POLICIES")], [policy["policy_no"]])

        self.assertEqual(self.http("POST", "/api/login", {"username": "juan", "password": "nope12"})[0], 401)
        self.assertEqual(self.http("POST", "/api/call", {"action": "LIST_POLICIES"}, "bad-token")[0], 401)
        self.assertEqual(self.http("POST", "/api/call", {"action": "LOGIN"}, juan)[0], 400)
        status, reply = self.http("POST", "/api/call", {"action": "SUMMARY"}, juan)
        self.assertEqual(status, 422)
        self.assertIn("permission denied", reply["error"])

    def test_message_document_and_events(self):
        juan = self.register_juan()
        agent = self.login("agent", "agent123")
        policy_no = self.call(agent, "CREATE_POLICY", customer="juan", policy_type="LIFE",
                              coverage=500_000, premium=1_200, term_months=12)["policy_no"]
        claim_no = self.call(juan, "FILE_CLAIM", policy_no=policy_no, description="Hospital",
                             amount=45_000)["claim_no"]

        # the agent's browser listens for live events
        events, ready = [], threading.Event()

        def listen():
            request = urllib.request.Request(f"http://127.0.0.1:{self.bridge.port}/api/events?token={agent}")
            with _opener.open(request, timeout=10) as stream:
                ready.set()
                for line in stream:
                    if line.startswith(b"data: "):
                        events.append(json.loads(line[6:]))
                        if len(events) == 2:
                            return

        listener = threading.Thread(target=listen, daemon=True)
        listener.start()
        self.assertTrue(ready.wait(5))

        status, peers = self.http("GET", "/api/peers", token=juan)
        self.assertEqual([(p["name"], p["online"]) for p in peers["data"]["peers"]], [("agent", True)])
        self.assertEqual(self.http("POST", "/api/messages", {"to": "agent", "text": "Hello, I filed a claim."},
                                   juan)[0], 200)

        content = os.urandom(150_000)
        status, sent = self.http("POST", f"/api/documents?to=agent&claim_no={claim_no}&filename=medical_report.pdf",
                                 token=juan, raw=content)
        self.assertEqual(status, 200, sent)
        self.assertTrue(sent["data"]["recorded"])
        digest = hashlib.sha256(content).hexdigest()
        self.assertEqual(sent["data"]["sent"]["sha256"], digest)

        listener.join(5)
        self.assertEqual([e["message"].get("text") for e in events][:1], ["Hello, I filed a claim."])
        self.assertEqual(events[1]["message"]["document"]["sha256"], digest)

        received = self.http("GET", "/api/received", token=agent)[1]["data"]
        self.assertEqual([(f["filename"], f["sha256"], f["from"]) for f in received],
                         [("medical_report.pdf", digest, "juan")])
        documents = self.call(agent, "LIST_DOCUMENTS", claim_no=claim_no)
        self.assertEqual(documents[0]["sha256"], digest)
        history = self.http("GET", "/api/messages", token=agent)[1]["data"]
        self.assertEqual([m["direction"] for m in history], ["in", "in"])

    def test_server_down(self):
        juan = self.register_juan()
        agent = self.login("agent", "agent123")
        self.http("GET", "/api/peers", token=juan)               # juan learns the agent's peer address
        self.server.shutdown()
        self.server = None

        self.assertEqual(self.http("GET", "/api/status", token=juan)[1]["data"]["server"], "offline")
        status, reply = self.http("POST", "/api/call", {"action": "LIST_POLICIES"}, juan)
        self.assertEqual(status, 503)
        self.assertTrue(reply["server_down"])
        status, peers = self.http("GET", "/api/peers", token=juan)
        self.assertEqual(peers["data"]["server"], "offline")
        self.assertEqual(self.http("POST", "/api/messages", {"to": "agent", "text": "still here"}, juan)[0], 200)
        history = self.http("GET", "/api/messages", token=agent)[1]["data"]
        self.assertEqual(history[-1]["text"], "still here")


if __name__ == "__main__":
    unittest.main()
