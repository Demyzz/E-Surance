# E-Surance

## Electronic Insurance Management System Design

A distributed insurance management system built using a hybrid Client-Server and Peer-to-Peer architecture.

Records (users, policies, payments, claims) go through one central server and one database. Messages and claim documents go directly between the users' computers, peer to peer. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code works.

---

## 1. Team Members

- [Demyzz](https://github.com/Demyzz)
- [Clayton28](https://github.com/Clayton28)
- [Ailkate](https://github.com/Ailkate)
- [marhanzeldizon-spec](https://github.com/marhanzeldizon-spec)

---

## 2. Prerequisites

Make sure the following is installed on your machine:

- Python 3.9 or newer (tested on Python 3.13)

The project uses only the Python standard library (`socket`, `threading`, `json`, `sqlite3`, `hashlib`), so there is nothing to install with pip.

---

## 3. Installation

```bash
git clone https://github.com/Demyzz/E-Surance.git
cd E-Surance
```

---

## 4. Get Your IP Address

Each computer needs the IP address of the server computer.

### Windows

```bash
ipconfig
```

### Linux

```bash
ip addr
```

### macOS

```bash
ipconfig getifaddr en0
```

Use the server's network address (for example `192.168.1.10`) on every computer, also on the server computer itself. The server tells the other users where your peer is from the address it sees, so `127.0.0.1` works only when all programs run on one computer.

---

## 5. Running the Project

Run every command from the project folder (`E-Surance/`). On some computers the command is `python3` instead of `python`.

### Start the Server

```bash
python -m server.main
```

The server listens on TCP port 5000 and keeps all records in `esurance.db`. Options: `--port 5001`, `--db other.db`, `--verbose` (log every request). Press Ctrl+C to stop.

### Start a Client (Customer, Agent, or Administrator)

```bash
python -m client.main --server <server_ip_address>:5000
```

Example:

```bash
python -m client.main --server 192.168.1.10:5000
```

Each client is also a peer node. It receives messages at once, and saves received documents in `received/`. Options: `--peer-port 6001` (default: any free port), `--inbox other_folder`.

### Start a Standalone Peer (Branch Office, No Server)

```bash
python -m peer.main --name alpha --port 6001
```

```bash
python -m peer.main --name beta --port 6002 --connect <alpha_ip_address>:6001
```

A new peer connects to one known peer with `--connect`, asks it for its peers, and so learns the other peers without the server.

### Demo Accounts

The server makes these accounts when the database is new. Customers register from the client menu.

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Agent | `agent` | `agent123` |

Change these passwords before a real use.

---

## 6. Demonstration

This is the full claim lifecycle: all three roles, the two models, and one server failure. Start the server, then three clients (customer, agent, administrator), on one computer or on different computers.

| Step | Who | Menu item | What happens | Model |
| --- | --- | --- | --- | --- |
| 1 | Customer | Register as a customer, then Log in | Account `juan` | Client-server |
| 2 | Agent | Log in (`agent` / `agent123`), Create a policy for a customer | `juan`, `LIFE`, coverage `500000`, premium `1200`, `12` months: POL-2026-0001 | Client-server |
| 3 | Customer | Pay a premium | `POL-2026-0001`, `1200`: PAY-2026-0001 | Client-server |
| 4 | Customer | File a claim | `45000`, hospital confinement: CLM-2026-0001 (PENDING) | Client-server |
| 5 | Customer | Online users (peer directory) | The server tells where the agent is | Client-server (directory) |
| 6 | Customer | Send a message to a user | "Hello, I filed a claim." appears at once on the agent's screen | Peer-to-peer |
| 7 | Customer | Send a claim document to a user | A file such as `medical_report.pdf` goes directly to the agent | Peer-to-peer |
| 8 | Customer | (same step) | The file name, size, and SHA-256 checksum are recorded on the claim | Client-server |
| 9 | Agent | Claims of my customers, Documents of a claim | 1 document; the checksum is the same as the file in the agent's `received/` | Client-server |
| 10 | Administrator | Log in (`admin` / `admin123`), Approve or reject a claim | CLM-2026-0001 is APPROVED | Client-server |
| 11 | Server | Ctrl+C (or `kill -9`, or End task) | The server stops | None |
| 12 | Customer | My policies | "The server is not available" | Client-server |
| 13 | Customer | Send a message to a user | The message still arrives | Peer-to-peer |
| 14 | Server | `python -m server.main` again | Starts with the same `esurance.db` | None |
| 15 | Customer | My policies | The client connects and logs in again by itself; the policy is there | Client-server |

The numbers have the current year, for example POL-2026-0001.

---

## 7. Run the Tests

```bash
python -m unittest -v
```

The 16 automated tests take about 2 seconds. Each test starts a real server and real peers on free local ports, with a temporary database.

| No. | Test | What the test shows |
| --- | --- | --- |
| 1 | Login is necessary | A request without a login gets "log in first" |
| 2 | Register and log in | A duplicate username and a wrong password are refused |
| 3 | Password storage | The database keeps a 64-character hash, not the password |
| 4 | Roles | A customer cannot create a policy or see the summary; an agent cannot decide a claim or create a user |
| 5 | Full insurance flow | Policy, payment, claim, approval, one decision only, summary |
| 6 | Scope | A customer cannot see, pay, or claim on the policy of a different customer |
| 7 | Bad input | Wrong policy type, text as an amount, unknown customer, unknown action |
| 8 | Many clients | 20 clients make 200 payments at the same time; all 200 references are different |
| 9 | Peer directory | The server lists the online peers, and removes a peer when it disconnects |
| 10 | Peer message | A message arrives, and the receiver learns the address of the sender |
| 11 | Peer file transfer | A 300,000-byte file arrives with the same bytes; a second file with the same name does not replace the first |
| 12 | Changed file | A file with a wrong checksum and an unsafe name is refused, and nothing is saved |
| 13 | Discovery without the server | A peer learns a third peer from a second peer |
| 14 | Peers without the server | Two peers exchange messages with no server running |
| 15 | Hybrid document flow | Directory, direct file, checksum record; the agent sees the same checksum |
| 16 | Server crash and recovery | The client detects the stop, the peers continue, and after the restart the client logs in again with the same records |

---

## 8. Project Structure

```txt
E-Surance/
├── common/
│   ├── protocol.py      # message format: 4-byte length header + JSON body
│   └── console.py       # text-menu helpers
├── server/
│   ├── main.py          # network layer: one thread for each client
│   ├── handlers.py      # service layer: route table, roles, business rules, peer directory
│   └── database.py      # data layer: all SQL, one lock, transactions
├── client/
│   ├── api.py           # connection to the server, automatic login again
│   └── main.py          # text menu for customers, agents, and administrators
├── peer/
│   ├── node.py          # PeerNode: listener, peer table, messages, file transfer
│   └── main.py          # standalone peer (branch office)
├── tests/
│   └── test_esurance.py # the 16 automated tests
├── ARCHITECTURE.md      # how the code works
└── README.md
```
