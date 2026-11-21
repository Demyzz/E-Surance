// The browser side of the bridge (bridge.py in the project folder).
// Records go through /api/call, which sends the same protocol request that
// the text menu sends. Messages and documents go to the bridge's peer node,
// which sends them directly to the other user's peer node.

export type Role = "customer" | "agent" | "admin";
export type PolicyType = "LIFE" | "HEALTH" | "MOTOR" | "PROPERTY";
export type ClaimStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface User {
  username: string;
  full_name: string;
  role: Role;
}

export interface Session {
  token: string;
  user: User;
  peer_port: number;
}

export interface UserRow extends User {
  created_at: string;
}

export interface Policy {
  policy_no: string;
  policy_type: PolicyType;
  customer: string;
  agent: string;
  coverage: number;
  premium: number;
  start_date: string;
  end_date: string;
  status: "ACTIVE" | "LAPSED" | "CANCELLED";
}

export interface Payment {
  reference: string;
  policy_no: string;
  amount: number;
  paid_by: string;
  paid_at: string;
}

export interface Claim {
  claim_no: string;
  policy_no: string;
  customer: string;
  description: string;
  amount: number;
  status: ClaimStatus;
  filed_at: string;
  decided_at: string | null;
  decided_by: string | null;
  remarks: string | null;
  documents: number;
}

export interface ClaimDocument {
  id: number;
  claim_no: string;
  filename: string;
  size: number;
  sha256: string;
  sent_by: string;
  sent_to: string;
  sent_at: string;
}

export interface Summary {
  users: Record<Role, number>;
  policies: { count: number; active: number; total_coverage: number };
  payments: { count: number; total: number };
  claims: Record<ClaimStatus, number> & { total_claimed: number; total_approved: number };
  documents: number;
}

export interface Peer {
  name: string;
  host: string;
  port: number;
  role: Role | null;
  online: boolean | null;
}

export interface FileInfo {
  filename: string;
  size: number;
  sha256: string;
}

export interface Message {
  id: number;
  at: string;
  direction: "in" | "out";
  peer: string;
  text?: string;
  document?: FileInfo;
  claim_no?: string;
}

export interface ReceivedFile extends FileInfo {
  from: string | null;
  at: string | null;
}

export interface SentDocument {
  sent: FileInfo & { saved_as: string };
  recorded: boolean;
  record_error: string | null;
  message: Message;
}

export type BridgeEvent = { type: "message"; message: Message } | { type: "closed" };

export class BridgeError extends Error {
  status: number;
  serverDown: boolean;
  bridgeDown: boolean;
  loggedOut: boolean;

  constructor(message: string, status: number, flags: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.serverDown = flags.server_down === true;
    this.bridgeDown = flags.bridge_down === true;
    this.loggedOut = flags.logged_out === true;
  }
}

const BRIDGE_DOWN =
  "The bridge is not running on this computer. Start it with: python bridge.py --server <server_ip>:5000";

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new BridgeError(BRIDGE_DOWN, 0, { bridge_down: true });
  }
  let payload: { ok?: boolean; data?: T; error?: string } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (payload === null) {
    // the dev server answers by itself when the bridge behind it is down
    throw new BridgeError(BRIDGE_DOWN, response.status, { bridge_down: true });
  }
  if (!response.ok || !payload.ok) {
    throw new BridgeError(payload.error ?? `request failed (${response.status})`, response.status, payload);
  }
  return payload.data as T;
}

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const api = {
  health: () => request<{ bridge: string; server: string }>("/api/health"),

  register: (username: string, password: string, full_name: string) =>
    request<User>("/api/register", json({ username, password, full_name })),

  login: (username: string, password: string) =>
    request<Session>("/api/login", json({ username, password })),

  logout: (token: string) => request<string>("/api/logout", json({}), token),

  status: (token: string) =>
    request<{ server: "online" | "offline"; user: User; peer_port: number }>("/api/status", {}, token),

  call: <T>(token: string, action: string, data: Record<string, unknown> = {}) =>
    request<T>("/api/call", json({ action, data }), token),

  peers: (token: string) =>
    request<{ server: "online" | "offline"; peers: Peer[] }>("/api/peers", {}, token),

  messages: (token: string) => request<Message[]>("/api/messages", {}, token),

  sendMessage: (token: string, to: string, text: string) =>
    request<Message>("/api/messages", json({ to, text }), token),

  sendDocument: (token: string, to: string, claimNo: string, file: File) => {
    const query = new URLSearchParams({ to, claim_no: claimNo, filename: file.name });
    return request<SentDocument>(
      `/api/documents?${query}`,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      token,
    );
  },

  received: (token: string) => request<ReceivedFile[]>("/api/received", {}, token),

  receivedUrl: (token: string, filename: string) =>
    `/api/received/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`,

  events: (token: string, onEvent: (event: BridgeEvent) => void) => {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (e) => onEvent(JSON.parse(e.data) as BridgeEvent);
    return source;
  },
};
