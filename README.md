# E-Surance

## Electronic Insurance Management System Design

A distributed insurance management system built using a hybrid Client-Server and Peer-to-Peer architecture.

Policies, payments and claims go through one central server and one SQLite database. Messages and claim documents (medical reports, photos of the damage) go directly from one user's computer to another, peer to peer, and the server keeps only each document's SHA-256 checksum. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code works.

---

## Team Members

- [Demyzz](https://github.com/Demyzz)
- [Clayton28](https://github.com/Clayton28)
- [Ailkate](https://github.com/Ailkate)
- [marhanzeldizon-spec](https://github.com/marhanzeldizon-spec)

---

## Prerequisites

Make sure the following are installed on your machine:

- Python 3.9 or newer
- Node.js 20.19 or newer, with npm

Dependencies are listed in:

- The Python standard library only (Backend): nothing to install
- `package.json` (Frontend)

---

## Installation

### Backend

```bash
cd backend
```

The backend uses only the Python standard library (`socket`, `threading`, `json`, `sqlite3`, `hashlib`, `http.server`), so there is no `pip install` step.

### Frontend

```bash
cd frontend/ui
npm install
```

---

## Get Your IP Address

### Windows

```bash
ipconfig
```

### Linux / macOS

```bash
ip addr
```

On macOS you can also use `ipconfig getifaddr en0`.

---

## Running the Project

E-Surance has one **server** for the whole group, and on **each user's computer** a **bridge** and the **frontend**. The bridge keeps that user's connection to the server and their peer node, which sends and receives messages and documents directly.

### Start the Server (one computer)

Navigate to the `backend/` directory and run:

```bash
python -m server.main
```

It listens on TCP port 5000 and keeps all records in `esurance.db`.

### Start the Bridge (each user's computer)

Navigate to the `backend/` directory and run:

```bash
python bridge.py --server <server_ip_address>:5000
```

Example:

```bash
python bridge.py --server 192.168.1.10:5000
```

Use the server's network address, also on the server computer itself. The server tells other users where your peer node is from the address it sees, so `127.0.0.1` works only when everyone uses the same computer.

### Start the Frontend (each user's computer)

Navigate to the `frontend/ui/` directory and run:

```bash
npm run dev
```

The frontend passes every `/api` request to the bridge on `http://127.0.0.1:8000`. If you start the bridge with another `--port`, copy `.env.example` to `.env.local` and change `BRIDGE_URL`.

Without the dev server: run `npm run build` once, and the bridge serves the built app itself at `http://localhost:8000/<customer|agent|admin>`.

---

## Access the Application

Open the following URL in your browser:

```txt
http://localhost:3000/<customer|agent|admin>
```

Example:

```txt
http://localhost:3000/customer
```

Each browser tab keeps its own login, so one computer can show a customer, an agent and an administrator in three tabs.

### Demo Accounts

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | `admin123` |
| Agent | `agent` | `agent123` |

Customers register on the customer page. Change the demo passwords before a real use.

---

## Demonstration

The full claim lifecycle: three roles, the two models, and one server failure.

| Step | Who | What to do | Model |
| --- | --- | --- | --- |
| 1 | Customer | Register `juan`, then log in | Client-server |
| 2 | Agent | Policies → New policy: `juan`, Life, coverage 500,000, premium 1,200, 12 months | Client-server |
| 3 | Customer | My policies → Pay premium | Client-server |
| 4 | Customer | My policies → File a claim: 45,000, hospital confinement | Client-server |
| 5 | Customer | Messages: the agent shows as online (the server's directory) | Client-server |
| 6 | Customer | Messages → "Hello, I filed a claim." It appears at once on the agent's screen | Peer-to-peer |
| 7 | Customer | Claims → the claim → Send document: `medical_report.pdf` to the agent | Peer-to-peer |
| 8 | Customer | (same step) The name, size and SHA-256 checksum are recorded on the claim | Client-server |
| 9 | Agent | Claims → the claim: the document shows **Verified copy** | Client-server |
| 10 | Administrator | Overview → Review → Approve | Client-server |
| 11 | Server | Ctrl+C (or `kill -9`, or End task) | None |
| 12 | Customer | The page shows **Server offline**; records do not load | Client-server |
| 13 | Customer | Messages → send a message; it still arrives | Peer-to-peer |
| 14 | Server | `python -m server.main` again, with the same `esurance.db` | None |
| 15 | Customer | Within 5 seconds: **Server online**, and the policy is there again | Client-server |

---

## Run the Tests

Navigate to the `backend/` directory and run:

```bash
python -m unittest -v
```

19 automated tests take about 4 seconds: the 16 tests of the design document (protocol, roles, scope, many clients, peer discovery, file transfer and checksum, server crash and recovery) and 3 tests of the bridge. Each test starts a real server and real peers on free local ports, with a temporary database.

---

## Text Menu (Optional)

The same system also runs without a browser:

```bash
python -m client.main --server <server_ip_address>:5000
```

```bash
python -m peer.main --name branch1 --port 6001
python -m peer.main --name branch2 --port 6002 --connect <branch1_ip_address>:6001
```

The first command is the text menu for customers, agents and administrators. The `peer.main` commands start standalone peers (a branch office) that find each other and exchange messages and files without the server.

---

## Project Structure

```txt
E-Surance/
├── backend/
│   ├── common/protocol.py   # 4-byte length header + JSON messages
│   ├── server/              # network, service and data layers
│   ├── client/              # server connection, text menu
│   ├── peer/                # PeerNode: messages, file transfer, checksum
│   ├── bridge.py            # HTTP bridge for the browser
│   └── tests/               # automated tests
├── frontend/
│   └── ui/                  # React + Vite + Tailwind web app
├── ARCHITECTURE.md
└── README.md
```
