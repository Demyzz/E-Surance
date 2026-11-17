"""Service layer: route table, role check, business rules, peer directory.

`Service.handle()` does four steps for each request:

1. Find the function for the action ("unknown action" if there is none).
2. If the action needs a login, make sure that the session has a user.
3. Make sure that the role of the user is in the list of roles for the action.
4. Run the function. A `RequestError` becomes an error reply for the client.

To add a feature, write one function and add one line to `self.routes`.
"""

import itertools
import logging
import math
import re
import threading
from datetime import date

from common.protocol import error, ok
from server.database import CLAIM_STATUSES, POLICY_TYPES, ROLES

log = logging.getLogger("esurance.server")

ALL_ROLES = frozenset(ROLES)
USERNAME_PATTERN = re.compile(r"[A-Za-z0-9_]{3,20}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
MIN_PASSWORD_LENGTH = 6
MAX_TERM_MONTHS = 600


class RequestError(Exception):
    """A request that breaks a rule. The message goes back to the client."""


class Session:
    """The user that is logged in on one connection."""

    _ids = itertools.count(1)

    def __init__(self, address):
        self.id = next(Session._ids)
        self.address = address
        self.user = None


class PeerDirectory:
    """Where the online users are: username -> host, port, role.

    The server is only the directory, like the central index of Napster:
    it tells a client where a peer is, but the data goes directly between
    the peers.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._peers = {}

    def add(self, username, host, port, role, session_id):
        with self._lock:
            self._peers[username] = {
                "username": username, "host": host, "port": port,
                "role": role, "session": session_id,
            }

    def remove(self, username, session_id=None):
        """Remove the user. With `session_id`, only if that session added it."""
        with self._lock:
            entry = self._peers.get(username)
            if entry and (session_id is None or entry["session"] == session_id):
                del self._peers[username]

    def list(self, exclude=None):
        with self._lock:
            entries = [dict(e) for name, e in sorted(self._peers.items()) if name != exclude]
        for entry in entries:
            del entry["session"]
        return entries


# -- input checks ------------------------------------------------------------

def _text(data, key, max_length=200, required=True):
    value = data.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise RequestError(f"{key} is required")
        return None
    if not isinstance(value, str):
        raise RequestError(f"{key} must be text")
    value = value.strip()
    if len(value) > max_length:
        raise RequestError(f"{key} must be {max_length} characters or less")
    return value


def _amount(data, key):
    value = data.get(key)
    if value is None:
        raise RequestError(f"{key} is required")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RequestError(f"{key} must be a number")
    if value <= 0:
        raise RequestError(f"{key} must be more than zero")
    return round(float(value), 2)


def _integer(data, key, low, high):
    value = data.get(key)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int):
        raise RequestError(f"{key} must be a whole number")
    if not low <= value <= high:
        raise RequestError(f"{key} must be from {low} to {high}")
    return value


def _username(data):
    username = _text(data, "username", max_length=20)
    if not USERNAME_PATTERN.fullmatch(username):
        raise RequestError("username must be 3 to 20 letters, digits, or _")
    return username


def _password(data):
    password = data.get("password")
    if not isinstance(password, str) or len(password) < MIN_PASSWORD_LENGTH:
        raise RequestError(f"password must be {MIN_PASSWORD_LENGTH} characters or more")
    if len(password) > 128:
        raise RequestError("password must be 128 characters or less")
    return password


def _public(user):
    return {"username": user["username"], "full_name": user["full_name"], "role": user["role"]}


class Service:
    def __init__(self, db, directory=None):
        self.db = db
        self.directory = directory or PeerDirectory()
        staff = frozenset({"admin", "agent"})
        admin = frozenset({"admin"})
        # action -> (function, roles); roles None = no login needed
        self.routes = {
            "PING":            (self.ping, None),
            "REGISTER":        (self.register, None),
            "LOGIN":           (self.login, None),
            "LOGOUT":          (self.logout, ALL_ROLES),
            "CREATE_USER":     (self.create_user, admin),
            "LIST_USERS":      (self.list_users, staff),
            "CREATE_POLICY":   (self.create_policy, staff),
            "LIST_POLICIES":   (self.list_policies, ALL_ROLES),
            "PAY_PREMIUM":     (self.pay_premium, ALL_ROLES),
            "LIST_PAYMENTS":   (self.list_payments, ALL_ROLES),
            "FILE_CLAIM":      (self.file_claim, frozenset({"customer"})),
            "LIST_CLAIMS":     (self.list_claims, ALL_ROLES),
            "DECIDE_CLAIM":    (self.decide_claim, admin),
            "RECORD_DOCUMENT": (self.record_document, ALL_ROLES),
            "LIST_DOCUMENTS":  (self.list_documents, ALL_ROLES),
            "SUMMARY":         (self.summary, admin),
            "LIST_PEERS":      (self.list_peers, ALL_ROLES),
        }

    # -- dispatcher --------------------------------------------------------

    def handle(self, session, message):
        action = message.get("action")
        data = message.get("data")
        if data is None:
            data = {}
        if not isinstance(data, dict):
            return error("data must be a JSON object")
        route = self.routes.get(action) if isinstance(action, str) else None
        if route is None:
            return error("unknown action")
        function, roles = route
        if roles is not None:
            if session.user is None:
                return error("log in first")
            if session.user["role"] not in roles:
                return error(f"permission denied: {action} is not for the role {session.user['role']}")
        try:
            return ok(function(session, data))
        except RequestError as exc:
            return error(exc)
        except Exception:
            log.exception("error in %s", action)
            return error("internal server error")

    def disconnect(self, session):
        """The connection closed: remove the user from the peer directory."""
        if session.user is not None:
            self.directory.remove(session.user["username"], session.id)
            log.info("%s disconnected", session.user["username"])
            session.user = None

    # -- accounts ----------------------------------------------------------

    def ping(self, session, data):
        return "pong"

    def register(self, session, data):
        """A new user can make only a customer account."""
        username = _username(data)
        password = _password(data)
        full_name = _text(data, "full_name", max_length=100)
        user = self.db.create_user(username, password, full_name, "customer")
        if user is None:
            raise RequestError("username already exists")
        log.info("registered customer %s", username)
        return _public(user)

    def login(self, session, data):
        username = _text(data, "username", max_length=20)
        password = data.get("password")
        if not isinstance(password, str):
            raise RequestError("password is required")
        p2p_port = data.get("p2p_port")
        if p2p_port is not None:
            p2p_port = _integer(data, "p2p_port", 1, 65535)
        user = self.db.authenticate(username, password)
        if user is None:
            raise RequestError("wrong username or password")
        if session.user is not None:
            self.directory.remove(session.user["username"], session.id)
        session.user = user
        if p2p_port is not None:
            self.directory.add(username, session.address[0], p2p_port, user["role"], session.id)
        log.info("%s logged in (%s), peer port %s", username, user["role"], p2p_port)
        return _public(user)

    def logout(self, session, data):
        self.directory.remove(session.user["username"], session.id)
        log.info("%s logged out", session.user["username"])
        session.user = None
        return "logged out"

    def create_user(self, session, data):
        """Only the administrator makes agent and administrator accounts."""
        username = _username(data)
        password = _password(data)
        full_name = _text(data, "full_name", max_length=100)
        role = _text(data, "role", max_length=20).lower()
        if role not in ROLES:
            raise RequestError("role must be customer, agent, or admin")
        user = self.db.create_user(username, password, full_name, role)
        if user is None:
            raise RequestError("username already exists")
        log.info("%s created %s account %s", session.user["username"], role, username)
        return _public(user)

    def list_users(self, session, data):
        role = _text(data, "role", max_length=20, required=False)
        if session.user["role"] == "agent":
            role = "customer"   # an agent sees customers only
        elif role is not None:
            role = role.lower()
            if role not in ROLES:
                raise RequestError("role must be customer, agent, or admin")
        return [_public(u) | {"created_at": u["created_at"]} for u in self.db.list_users(role)]

    # -- policies and payments ---------------------------------------------

    def create_policy(self, session, data):
        customer_name = _text(data, "customer", max_length=20)
        customer = self.db.get_user(customer_name)
        if customer is None or customer["role"] != "customer":
            raise RequestError("customer not found")
        policy_type = _text(data, "policy_type", max_length=20).upper()
        if policy_type not in POLICY_TYPES:
            raise RequestError("policy_type must be LIFE, HEALTH, MOTOR, or PROPERTY")
        coverage = _amount(data, "coverage")
        premium = _amount(data, "premium")
        if premium >= coverage:
            raise RequestError("premium must be less than the coverage")
        term_months = _integer(data, "term_months", 1, MAX_TERM_MONTHS)
        policy = self.db.create_policy(
            customer["id"], session.user["id"], policy_type, coverage, premium, term_months
        )
        log.info("%s created %s for %s", session.user["username"], policy["policy_no"], customer_name)
        return policy

    def list_policies(self, session, data):
        return self.db.list_policies(session.user)

    def _policy_in_scope(self, session, data):
        policy_no = _text(data, "policy_no", max_length=30)
        policy = self.db.get_policy(session.user, policy_no)
        if policy is None:
            # Same reply when the policy exists but belongs to someone else,
            # so the reply does not tell that the policy exists.
            raise RequestError("policy not found")
        return policy

    def pay_premium(self, session, data):
        policy = self._policy_in_scope(session, data)
        amount = _amount(data, "amount")
        if policy["status"] != "ACTIVE":
            raise RequestError("policy is not active")
        payment = self.db.add_payment(policy["id"], session.user["id"], amount)
        log.info("%s paid %.2f on %s", session.user["username"], amount, policy["policy_no"])
        return payment

    def list_payments(self, session, data):
        return self.db.list_payments(session.user)

    # -- claims ------------------------------------------------------------

    def file_claim(self, session, data):
        policy = self._policy_in_scope(session, data)
        description = _text(data, "description", max_length=500)
        amount = _amount(data, "amount")
        if policy["status"] != "ACTIVE":
            raise RequestError("policy is not active")
        if date.fromisoformat(policy["end_date"]) < date.today():
            raise RequestError("policy has expired")
        if amount > policy["coverage"]:
            raise RequestError("claim amount is more than the coverage")
        claim = self.db.add_claim(policy["id"], description, amount)
        log.info("%s filed %s on %s", session.user["username"], claim["claim_no"], policy["policy_no"])
        return claim

    def list_claims(self, session, data):
        status = _text(data, "status", max_length=20, required=False)
        if status is not None:
            status = status.upper()
            if status not in CLAIM_STATUSES:
                raise RequestError("status must be PENDING, APPROVED, or REJECTED")
        return self.db.list_claims(session.user, status)

    def decide_claim(self, session, data):
        """A claim gets only one decision."""
        claim_no = _text(data, "claim_no", max_length=30)
        decision = _text(data, "decision", max_length=20).upper()
        decision = {"APPROVE": "APPROVED", "REJECT": "REJECTED"}.get(decision, decision)
        if decision not in ("APPROVED", "REJECTED"):
            raise RequestError("decision must be APPROVED or REJECTED")
        remarks = _text(data, "remarks", max_length=500, required=False)
        result = self.db.decide_claim(claim_no, decision, session.user["id"], remarks)
        if result == "not_found":
            raise RequestError("claim not found")
        if result == "decided":
            raise RequestError("claim already has a decision")
        log.info("%s set %s to %s", session.user["username"], claim_no, decision)
        return self.db.get_claim(session.user, claim_no)

    # -- documents (the link between the two models) -----------------------

    def record_document(self, session, data):
        """Keep the proof of a document that moved peer to peer.

        The server keeps the name, the size, and the checksum. It never gets
        the file itself.
        """
        claim_no = _text(data, "claim_no", max_length=30)
        filename = _text(data, "filename", max_length=255)
        size = _integer(data, "size", 0, 2**53)
        sha256 = _text(data, "sha256", max_length=64).lower()
        if not SHA256_PATTERN.fullmatch(sha256):
            raise RequestError("sha256 must be 64 hexadecimal characters")
        sent_to = _text(data, "sent_to", max_length=50)
        document = self.db.add_document(session.user, claim_no, filename, size, sha256, sent_to)
        if document is None:
            raise RequestError("claim not found")
        log.info("RECORD_DOCUMENT %s %s (%d bytes, sha256 %s) %s -> %s",
                 claim_no, filename, size, sha256[:12], session.user["username"], sent_to)
        return document

    def list_documents(self, session, data):
        claim_no = _text(data, "claim_no", max_length=30)
        if self.db.get_claim(session.user, claim_no) is None:
            raise RequestError("claim not found")
        return self.db.list_documents(claim_no)

    # -- reports and directory ---------------------------------------------

    def summary(self, session, data):
        return self.db.summary()

    def list_peers(self, session, data):
        return self.directory.list(exclude=session.user["username"])
