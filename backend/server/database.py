"""Data layer: the only module that contains SQL.

One SQLite connection is shared by all client threads. `Database._lock` lets
only one thread use it at a time, and each change runs in one transaction, so
an error cancels the whole change.

Every query takes its values as parameters (`?`), so text from a user can
never change an SQL statement.
"""

import calendar
import hashlib
import hmac
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime

ROLES = ("customer", "agent", "admin")
POLICY_TYPES = ("LIFE", "HEALTH", "MOTOR", "PROPERTY")
CLAIM_STATUSES = ("PENDING", "APPROVED", "REJECTED")

PBKDF2_ROUNDS = 100_000
SALT_BYTES = 16

# Demo accounts made when the database is new. Change them before real use.
DEMO_ACCOUNTS = (
    ("admin", "admin123", "System Administrator", "admin"),
    ("agent", "agent123", "Default Agent", "agent"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('customer', 'agent', 'admin')),
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
    id          INTEGER PRIMARY KEY,
    policy_no   TEXT UNIQUE,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    agent_id    INTEGER NOT NULL REFERENCES users(id),
    policy_type TEXT NOT NULL CHECK (policy_type IN ('LIFE', 'HEALTH', 'MOTOR', 'PROPERTY')),
    coverage    REAL NOT NULL CHECK (coverage > 0),
    premium     REAL NOT NULL CHECK (premium > 0 AND premium < coverage),
    start_date  TEXT NOT NULL,
    end_date    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'LAPSED', 'CANCELLED'))
);

CREATE TABLE IF NOT EXISTS payments (
    id        INTEGER PRIMARY KEY,
    reference TEXT UNIQUE,
    policy_id INTEGER NOT NULL REFERENCES policies(id),
    paid_by   INTEGER NOT NULL REFERENCES users(id),
    amount    REAL NOT NULL CHECK (amount > 0),
    paid_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
    id          INTEGER PRIMARY KEY,
    claim_no    TEXT UNIQUE,
    policy_id   INTEGER NOT NULL REFERENCES policies(id),
    description TEXT NOT NULL,
    amount      REAL NOT NULL CHECK (amount > 0),
    status      TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    filed_at    TEXT NOT NULL,
    decided_at  TEXT,
    decided_by  INTEGER REFERENCES users(id),
    remarks     TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id       INTEGER PRIMARY KEY,
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    filename TEXT NOT NULL,
    size     INTEGER NOT NULL CHECK (size >= 0),
    sha256   TEXT NOT NULL CHECK (length(sha256) = 64),
    sent_by  INTEGER NOT NULL REFERENCES users(id),
    sent_to  TEXT NOT NULL,
    sent_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policies_customer ON policies(customer_id);
CREATE INDEX IF NOT EXISTS idx_policies_agent    ON policies(agent_id);
CREATE INDEX IF NOT EXISTS idx_payments_policy   ON payments(policy_id);
CREATE INDEX IF NOT EXISTS idx_claims_policy     ON claims(policy_id);
CREATE INDEX IF NOT EXISTS idx_documents_claim   ON documents(claim_id);
"""

_POLICY_COLUMNS = """
    p.id, p.policy_no, p.policy_type, p.coverage, p.premium, p.start_date,
    p.end_date, p.status, c.username AS customer, a.username AS agent
"""
_POLICY_FROM = """
    FROM policies p
    JOIN users c ON c.id = p.customer_id
    JOIN users a ON a.id = p.agent_id
"""


def hash_password(password, salt_hex):
    """PBKDF2-SHA256, 100,000 rounds; returns 64 hex characters."""
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ROUNDS
    )
    return digest.hex()


def add_months(start, months):
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _scope(user):
    """The SQL condition that limits policy rows to what `user` may see.

    A customer sees own policies, an agent sees the policies of own
    customers, and the administrator sees all policies.
    """
    if user["role"] == "customer":
        return "p.customer_id = ?", [user["id"]]
    if user["role"] == "agent":
        return "p.agent_id = ?", [user["id"]]
    return "1 = 1", []


class Database:
    def __init__(self, path, seed_demo_accounts=True):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(SCHEMA)
        if seed_demo_accounts and self._count_users() == 0:
            for username, password, full_name, role in DEMO_ACCOUNTS:
                self.create_user(username, password, full_name, role)

    def close(self):
        with self._lock:
            self._conn.close()

    # -- helpers -----------------------------------------------------------

    @contextmanager
    def _transaction(self):
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def _all(self, sql, params=()):
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params)]

    def _one(self, sql, params=()):
        rows = self._all(sql, params)
        return rows[0] if rows else None

    @staticmethod
    def _insert_numbered(conn, table, column, prefix, sql, params):
        """Insert a row and set its number from the row id, in one transaction.

        The number (for example CLM-2026-0007) comes from the row id, so two
        clients can never get the same number and no search is needed.
        """
        rowid = conn.execute(sql, params).lastrowid
        number = f"{prefix}-{date.today().year}-{rowid:04d}"
        conn.execute(f"UPDATE {table} SET {column} = ? WHERE id = ?", (number, rowid))
        return number

    def _count_users(self):
        return self._one("SELECT COUNT(*) AS n FROM users")["n"]

    # -- users -------------------------------------------------------------

    def create_user(self, username, password, full_name, role):
        """Return the new user, or None if the username is taken."""
        salt = os.urandom(SALT_BYTES).hex()
        password_hash = hash_password(password, salt)
        try:
            with self._transaction() as conn:
                conn.execute(
                    "INSERT INTO users (username, password_hash, salt, full_name, role, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (username, password_hash, salt, full_name, role, _now()),
                )
        except sqlite3.IntegrityError:
            return None
        return self.get_user(username)

    def get_user(self, username):
        return self._one(
            "SELECT id, username, full_name, role, created_at FROM users WHERE username = ?",
            (username,),
        )

    def authenticate(self, username, password):
        row = self._one("SELECT id, password_hash, salt FROM users WHERE username = ?", (username,))
        if row is None:
            # Do the same work for an unknown name, so the time does not tell
            # whether the username exists.
            hash_password(password, "00" * SALT_BYTES)
            return None
        if not hmac.compare_digest(hash_password(password, row["salt"]), row["password_hash"]):
            return None
        return self.get_user(username)

    def list_users(self, role=None):
        sql = "SELECT id, username, full_name, role, created_at FROM users"
        params = []
        if role:
            sql += " WHERE role = ?"
            params.append(role)
        return self._all(sql + " ORDER BY id", params)

    # -- policies ----------------------------------------------------------

    def create_policy(self, customer_id, agent_id, policy_type, coverage, premium, term_months):
        start = date.today()
        end = add_months(start, term_months)
        with self._transaction() as conn:
            policy_no = self._insert_numbered(
                conn, "policies", "policy_no", "POL",
                "INSERT INTO policies (customer_id, agent_id, policy_type, coverage, premium,"
                " start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (customer_id, agent_id, policy_type, coverage, premium,
                 start.isoformat(), end.isoformat()),
            )
        return self._one(f"SELECT {_POLICY_COLUMNS} {_POLICY_FROM} WHERE p.policy_no = ?", (policy_no,))

    def list_policies(self, user):
        where, params = _scope(user)
        return self._all(f"SELECT {_POLICY_COLUMNS} {_POLICY_FROM} WHERE {where} ORDER BY p.id", params)

    def get_policy(self, user, policy_no):
        """The policy, only if it is in the scope of `user`."""
        where, params = _scope(user)
        return self._one(
            f"SELECT {_POLICY_COLUMNS} {_POLICY_FROM} WHERE p.policy_no = ? AND {where}",
            [policy_no, *params],
        )

    # -- payments ----------------------------------------------------------

    def add_payment(self, policy_id, paid_by, amount):
        with self._transaction() as conn:
            reference = self._insert_numbered(
                conn, "payments", "reference", "PAY",
                "INSERT INTO payments (policy_id, paid_by, amount, paid_at) VALUES (?, ?, ?, ?)",
                (policy_id, paid_by, amount, _now()),
            )
        return self._one(
            "SELECT pay.reference, p.policy_no, pay.amount, u.username AS paid_by, pay.paid_at"
            " FROM payments pay JOIN policies p ON p.id = pay.policy_id"
            " JOIN users u ON u.id = pay.paid_by WHERE pay.reference = ?",
            (reference,),
        )

    def list_payments(self, user):
        where, params = _scope(user)
        return self._all(
            "SELECT pay.reference, p.policy_no, pay.amount, u.username AS paid_by, pay.paid_at"
            " FROM payments pay JOIN policies p ON p.id = pay.policy_id"
            f" JOIN users u ON u.id = pay.paid_by WHERE {where} ORDER BY pay.id",
            params,
        )

    # -- claims ------------------------------------------------------------

    _CLAIM_SELECT = (
        "SELECT cl.claim_no, p.policy_no, c.username AS customer, cl.description, cl.amount,"
        " cl.status, cl.filed_at, cl.decided_at, d.username AS decided_by, cl.remarks,"
        " (SELECT COUNT(*) FROM documents doc WHERE doc.claim_id = cl.id) AS documents"
        " FROM claims cl JOIN policies p ON p.id = cl.policy_id"
        " JOIN users c ON c.id = p.customer_id"
        " LEFT JOIN users d ON d.id = cl.decided_by"
    )

    def add_claim(self, policy_id, description, amount):
        with self._transaction() as conn:
            claim_no = self._insert_numbered(
                conn, "claims", "claim_no", "CLM",
                "INSERT INTO claims (policy_id, description, amount, filed_at) VALUES (?, ?, ?, ?)",
                (policy_id, description, amount, _now()),
            )
        return self._one(self._CLAIM_SELECT + " WHERE cl.claim_no = ?", (claim_no,))

    def list_claims(self, user, status=None):
        where, params = _scope(user)
        sql = self._CLAIM_SELECT + f" WHERE {where}"
        if status:
            sql += " AND cl.status = ?"
            params.append(status)
        return self._all(sql + " ORDER BY cl.id", params)

    def get_claim(self, user, claim_no):
        where, params = _scope(user)
        return self._one(
            self._CLAIM_SELECT + f" WHERE cl.claim_no = ? AND {where}", [claim_no, *params]
        )

    def decide_claim(self, claim_no, status, decided_by, remarks):
        """Return "done", "decided" (already had a decision) or "not_found".

        The UPDATE has the condition status = 'PENDING', so when two
        administrators decide at the same time only one UPDATE changes the row.
        """
        with self._transaction() as conn:
            changed = conn.execute(
                "UPDATE claims SET status = ?, decided_by = ?, decided_at = ?, remarks = ?"
                " WHERE claim_no = ? AND status = 'PENDING'",
                (status, decided_by, _now(), remarks, claim_no),
            ).rowcount
            if changed:
                return "done"
            exists = conn.execute("SELECT 1 FROM claims WHERE claim_no = ?", (claim_no,)).fetchone()
            return "decided" if exists else "not_found"

    # -- documents ---------------------------------------------------------

    def add_document(self, user, claim_no, filename, size, sha256, sent_to):
        """Record a document that moved peer to peer. None if the claim is not in scope."""
        where, params = _scope(user)
        with self._transaction() as conn:
            claim = conn.execute(
                "SELECT cl.id FROM claims cl JOIN policies p ON p.id = cl.policy_id"
                f" WHERE cl.claim_no = ? AND {where}",
                [claim_no, *params],
            ).fetchone()
            if claim is None:
                return None
            doc_id = conn.execute(
                "INSERT INTO documents (claim_id, filename, size, sha256, sent_by, sent_to, sent_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (claim["id"], filename, size, sha256, user["id"], sent_to, _now()),
            ).lastrowid
        return self._one(self._DOCUMENT_SELECT + " WHERE doc.id = ?", (doc_id,))

    _DOCUMENT_SELECT = (
        "SELECT doc.id, cl.claim_no, doc.filename, doc.size, doc.sha256,"
        " u.username AS sent_by, doc.sent_to, doc.sent_at"
        " FROM documents doc JOIN claims cl ON cl.id = doc.claim_id"
        " JOIN users u ON u.id = doc.sent_by"
    )

    def list_documents(self, claim_no):
        return self._all(self._DOCUMENT_SELECT + " WHERE cl.claim_no = ? ORDER BY doc.id", (claim_no,))

    # -- report ------------------------------------------------------------

    def summary(self):
        users = {role: 0 for role in ROLES}
        for row in self._all("SELECT role, COUNT(*) AS n FROM users GROUP BY role"):
            users[row["role"]] = row["n"]
        policies = self._one(
            "SELECT COUNT(*) AS count,"
            " COALESCE(SUM(status = 'ACTIVE'), 0) AS active,"
            " COALESCE(SUM(coverage), 0) AS total_coverage FROM policies"
        )
        payments = self._one("SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM payments")
        claims = {status: 0 for status in CLAIM_STATUSES}
        for row in self._all("SELECT status, COUNT(*) AS n FROM claims GROUP BY status"):
            claims[row["status"]] = row["n"]
        totals = self._one(
            "SELECT COALESCE(SUM(amount), 0) AS claimed,"
            " COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN amount END), 0) AS approved FROM claims"
        )
        claims["total_claimed"] = totals["claimed"]
        claims["total_approved"] = totals["approved"]
        documents = self._one("SELECT COUNT(*) AS n FROM documents")["n"]
        return {
            "users": users,
            "policies": policies,
            "payments": payments,
            "claims": claims,
            "documents": documents,
        }
