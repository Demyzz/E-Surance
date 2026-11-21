# E-Surance System Architecture

E-Surance is an electronic insurance management system. It uses two models in
one application. Records go through a central server (client-server). Messages
and claim documents go directly between users (peer-to-peer).

The Python code is a server, the client programs, and a peer node. Between
these programs, all communication uses TCP sockets from the Python standard
library, with no RPC framework. The web frontend (`frontend/ui`) reaches the
system only through the bridge (`bridge.py`) on the user's own computer, which
turns browser actions into the same protocol messages (Section 7). Module paths
below are relative to the project folder.

Source: Section 2 of the E-Surance Project Documentation, with the module map
and request flow taken from Sections 3, 4 and 7. Run commands are in the README.

## 1. The Hybrid Model

The system has one central server and many client programs. Each client program
has two parts: a connection to the server and a peer node.

```
+--------------------------------------------------------------------------------+
| E-Surance server (one process, TCP port 5000)                                  |
|                                                                                |
|  +------------------+      +--------------------+      +-------------------+   |
|  | Network layer    | ---> | Service layer      | ---> | Data layer        |   |
|  | server/main.py   |      | server/handlers.py |      | server/database.py|   |
|  | one thread for   |      | role check,        |      | all SQL, one lock |   |
|  | each client      |      | business rules     |      |                   |   |
|  +------------------+      +--------------------+      +-------------------+   |
|          |                          |                           |              |
|          v                          v                           v              |
|  +------------------+      +--------------------+      +-------------------+   |
|  | Sessions         |      | Peer directory     |      | esurance.db       |   |
|  | the user on each |      | who is online, at  |      | SQLite, five      |   |
|  | connection       |      | which port         |      | tables            |   |
|  +------------------+      +--------------------+      +-------------------+   |
+--------------------------------------------------------------------------------+
          ^                          ^                           ^
          |  request and reply (JSON), one TCP connection per program
          v                          v                           v
+--------------------+     +--------------------+     +-----------------------+
| Customer program   |     | Agent program      |     | Administrator program |
|                    |     |                    |     |                       |
| Server connection  |     | Server connection  |     | Server connection     |
| client/api.py      |     | client/api.py      |     | client/api.py         |
|                    |     |                    |     |                       |
| Peer node          |<===>| Peer node          |<===>| Peer node             |
| peer/node.py,      |     | peer/node.py,      |     | peer/node.py,         |
| own port           |     | own port           |     | own port              |
+--------------------+     +--------------------+     +-----------------------+
          ^                                                       ^
          +=======================================================+

  ---  client-server link: request and reply (JSON) to the server
  ===  peer-to-peer link: direct TCP between peers: HELLO, PEERS, CHAT, FILE (no server)
```

- **Client-server link.** Each client opens one TCP connection to the server on
  port 5000. The client sends a request and waits for the reply. Only the server
  reads and writes the database.
- **Peer-to-peer link.** Each peer node has its own listen port. For each message
  or document, a peer opens a short TCP connection directly to the other peer.
- **Directory.** At login, the client tells the server its peer port. The
  `LIST_PEERS` action gives the address of each user that is online.

Each type of data is on the model that fits it:

- Records (users, policies, payments, claims) go through the server. One
  database is the single source of truth, and the server checks the role of the
  user for each request.
- Documents and messages go directly between peers. The server is not in the
  data path. The receiver verifies each document with a SHA-256 checksum.
- The server keeps only the proof: for each claim document, the file name, the
  size, and the checksum (`RECORD_DOCUMENT`).
- The peers continue when the server stops. Each peer keeps its last peer table.

## 2. Module Map

| Module | Process | What it does |
| --- | --- | --- |
| `server/main.py` | Server | Network layer: accepts TCP connections, starts one thread for each client, reads each request and sends the reply |
| `server/handlers.py` | Server | Service layer: the `Service` class finds the function for the action, checks the role, applies the business rules, keeps the peer directory |
| `server/database.py` | Server | Data layer: contains all SQL, protects the connection with one lock, makes each change in one transaction |
| `common/protocol.py` | All | The message format (4-byte length header + JSON body), shared by the server, the client, and the peer |
| `common/console.py` | Client, standalone peer | Text-menu helpers; one print lock, so a message that arrives while the user types prints cleanly |
| `client/api.py` | Client | `EsuranceClient`: the one connection to the server; no automatic retry; reconnects and logs in again before the next request |
| `client/main.py` | Client | The text menu for customers, agents, and administrators; uses a `PeerNode` for messages and documents |
| `peer/node.py` | Client, peer | The `PeerNode` class: listener (server role), send functions (client role), peer table, receiver safety checks |
| `peer/main.py` | Standalone peer | Uses `PeerNode` without the server (branch office); joins with `--connect` to one known peer |
| `bridge.py` | Each user's computer | The web bridge: for each browser login, one `EsuranceClient` and one `PeerNode`; HTTP API and live events for the browser |
| `tests/test_esurance.py` | Tests | The 16 automated tests of the design, with a real server and real peers on free local ports |
| `tests/test_bridge.py` | Tests | 3 tests of the bridge over HTTP: records, a message and a document between two logins, and the server down |
| `frontend/ui/` | Browser | React + Vite + Tailwind web app: a portal for each role at `/customer`, `/agent`, `/admin` |

## 3. The Server: Three Layers

The server code has three layers. Each layer calls only the layer below it.
Thus a change to the database does not change the network code.

```
server/main.py  -->  server/handlers.py  -->  server/database.py  -->  esurance.db
  (Network)            (Service)               (Data)
```

All programs use `common/protocol.py` for the message format. One protocol
module for the server, the client, and the peer means less code and fewer
errors.

### How one request flows through the server

1. `server/main.py` reads the 4-byte length header, then exactly that number of
   bytes, and decodes the JSON body. A message larger than 1 MB, or that is not a
   JSON object, is refused.
2. `Service.handle()` in `server/handlers.py` uses one route table
   (action to (function, roles)) and does four steps:
    1. Find the function for the action. If there is no function, reply
       "unknown action".
    2. If the action needs a login, make sure that the session has a user.
    3. Make sure that the role of the user is in the list of roles for the action.
    4. Run the function. If the function raises `RequestError`, send its message
       to the client.
3. The function calls `server/database.py`, which adds the scope condition to the
   SQL `WHERE` clause (a customer sees own records, an agent sees own customers'
   records, the administrator sees all).
4. The reply goes back on the same connection.

To add a feature, write one function and add one line to the route table. The
network code and the menu code do not change.

## 4. The Peer Node: A Server and a Client in One Process

In the peer-to-peer model, all processes have the same role. The `PeerNode`
class in `peer/node.py` has the two roles:

- **Server role.** A listener thread accepts connections from other peers. Each
  incoming request gets a short thread.
- **Client role.** The send functions (`hello`, `ask_peers`, `send_chat`,
  `send_file`) open a connection to a different peer.
- **Peer table.** The node keeps the name, host, and port of each peer that it
  knows.

The client menu uses a `PeerNode` object. The standalone program `peer/main.py`
uses the same class without the server.

A peer learns a new peer table entry in three ways: from the server directory
(`LIST_PEERS`), from the `from` and `listen_port` fields of any message it
receives, or from another peer (`PEERS`).

## 5. Internal State Structures

| Structure | Process | Type | Purpose | Persisted |
| --- | --- | --- | --- | --- |
| `users`, `policies`, `payments`, `claims`, `documents` | Server | SQLite tables | The insurance records | Yes: `esurance.db` |
| `Session` | Server | One object for each connection | The user that is logged in on this connection | No |
| `PeerDirectory` | Server | dict: username to host, port, role | Tells where the online peers are | No (made again at login) |
| `_connections` | Server | set of sockets | Lets the server close all clients at shutdown | No |
| `known_peers` | Peer | dict: name to (host, port) | The peer table for direct connections | No |
| Inbox folder | Peer | Files | The documents that the peer received | Yes: `received/` |

## 6. Threads and Locks

- **Server.** The main thread accepts connections. For each new client, it starts
  a thread that runs `_serve_client`. The accept call has a 0.5-second timeout,
  so the main thread can see Ctrl+C and stop.
- **Peer.** The listener thread accepts connections. Each incoming request gets a
  short thread, so a large file does not stop a chat message.
- **Client.** The menu runs in the main thread. The peer listener runs in a
  different thread, so a message can arrive while the user types.

| Shared data | Lock | Protects against |
| --- | --- | --- |
| SQLite connection | `Database._lock` | Two threads that use the connection at the same time |
| Peer directory | `PeerDirectory._lock` | A login and a logout that change the directory at the same time |
| Open client sockets | `_connections_lock` | A new connection during shutdown |
| Peer table | `PeerNode._lock` | Two incoming messages that add peers at the same time |
| Client connection | `EsuranceClient._lock` | Two requests on one socket at the same time |
| Bridge logins | `Bridge._lock` | Two browser logins or logouts at the same time |
| Message history, event listeners | `BridgeSession._lock` | A peer message that arrives while the browser reads the history |

Each lock is held only for a short operation. No code path holds two different
locks at the same time, so a deadlock cannot occur.

## 7. The Web Bridge and the Frontend

A browser cannot open a raw TCP socket, so it cannot be a client program by
itself. Each user's computer runs the bridge next to the frontend:

```
 Browser (frontend/ui, port 3000)
     |  HTTP /api/... on this computer
     v
 bridge.py (port 8000)
     |-- one BridgeSession for each browser login
     |     |-- EsuranceClient --- TCP, length + JSON ---> server (port 5000)
     |     '-- PeerNode (own port) <== TCP, direct ==> other users' peer nodes
     '-- Server-Sent Events: incoming messages and documents, at once
```

So the design does not change: each login still has one connection to the
server and one peer node, and documents still go from one user's peer node to
the other's. The bridge only carries clicks to the same code that the text menu
uses.

| Browser request | What the bridge does |
| --- | --- |
| `POST /api/login` | Starts a `PeerNode`, then `LOGIN` with its `p2p_port`; returns a token for this browser tab |
| `POST /api/call` | Sends one client-server request (`LIST_POLICIES`, `FILE_CLAIM`, ...) on this login's connection; `LOGIN`, `LOGOUT` and `REGISTER` are refused here |
| `GET /api/status` | `PING` on this login's connection: the page shows Server online or offline (every 5 s) |
| `GET /api/peers` | `LIST_PEERS`, then the peer table; when the server is off, the last peer table |
| `POST /api/messages` | `CHAT` directly to the other peer |
| `POST /api/documents` | `FILE` directly to the other peer, then `RECORD_DOCUMENT` with the checksum |
| `GET /api/received` | The documents in this login's inbox, each with its SHA-256 |
| `GET /api/events` | Server-Sent Events for incoming `CHAT` and `FILE` |

The bridge listens on 127.0.0.1 by default, so only the browser on the same
computer can use it. The peer node listens on all addresses, so other users'
peers can reach it.

The agent's claim page compares each recorded checksum with the files in the
agent's inbox: "Verified copy" means that the received file has the same
SHA-256 value as the one that the server recorded.

## 8. Running the Tests

```
python -m unittest -v
```

All 19 automated tests run in about 4 seconds on Python 3.13: the 16 tests of
the design and 3 tests of the bridge. Each test starts a real server and real
peers on free local ports, with a temporary database.
