import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, BridgeError, type Message, type Session } from "./api";

export type Link = "online" | "offline" | "unknown";

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  body?: string;
}

interface SessionValue {
  session: Session | null;
  server: Link;
  bridge: Link;
  login: (username: string, password: string) => Promise<Session>;
  logout: () => Promise<void>;
  /** One client-server request through the bridge. */
  call: <T>(action: string, data?: Record<string, unknown>) => Promise<T>;
  /** Any other bridge request that needs the login token. */
  run: <T>(request: (token: string) => Promise<T>) => Promise<T>;
  onMessage: (listener: (message: Message) => void) => () => void;
  unread: number;
  setReading: (reading: boolean) => void;
  toasts: Toast[];
  notify: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_KEY = "esurance.session";
const STATUS_EVERY_MS = 5000;

// sessionStorage keeps one login per browser tab, so a customer, an agent and
// an administrator can each have a tab on the same computer.
function stored(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function store(session: Session | null) {
  try {
    if (session) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode: the login lasts until the page reloads
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(stored);
  const [server, setServer] = useState<Link>("unknown");
  const [bridge, setBridge] = useState<Link>("unknown");
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const listeners = useRef(new Set<(message: Message) => void>());
  const reading = useRef(false);
  const toastIds = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = ++toastIds.current;
      setToasts((all) => [...all.slice(-3), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), 5200);
    },
    [dismiss],
  );

  const forget = useCallback(() => {
    store(null);
    setSession(null);
    setServer("unknown");
    setUnread(0);
  }, []);

  const note = useCallback(
    (error: unknown) => {
      if (!(error instanceof BridgeError)) return;
      if (error.serverDown) setServer("offline");
      if (error.bridgeDown) setBridge("offline");
      if (error.loggedOut) forget();
    },
    [forget],
  );

  const run = useCallback(
    async <T,>(request: (token: string) => Promise<T>) => {
      if (!session) throw new BridgeError("log in first", 401, { logged_out: true });
      try {
        const result = await request(session.token);
        setBridge("online");
        return result;
      } catch (error) {
        note(error);
        throw error;
      }
    },
    [session, note],
  );

  const call = useCallback(
    async <T,>(action: string, data: Record<string, unknown> = {}) => {
      const result = await run((token) => api.call<T>(token, action, data));
      setServer("online");
      return result;
    },
    [run],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      try {
        const next = await api.login(username, password);
        store(next);
        setSession(next);
        setServer("online");
        setBridge("online");
        return next;
      } catch (error) {
        note(error);
        throw error;
      }
    },
    [note],
  );

  const logout = useCallback(async () => {
    if (session) await api.logout(session.token).catch(() => undefined);
    forget();
  }, [session, forget]);

  // Is the server up? PING on this login's own connection, every 5 seconds.
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const check = () =>
      api
        .status(session.token)
        .then((status) => {
          if (stopped) return;
          setServer(status.server);
          setBridge("online");
        })
        .catch(note);
    check();
    const timer = window.setInterval(check, STATUS_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [session, note]);

  // Messages and documents from other peers arrive here as they happen.
  useEffect(() => {
    if (!session) return;
    const source = api.events(session.token, (event) => {
      if (event.type !== "message") return;
      listeners.current.forEach((listener) => listener(event.message));
      const message = event.message;
      if (message.direction === "in" && !reading.current) {
        setUnread((n) => n + 1);
        notify({
          tone: "info",
          title: message.document ? `Document from ${message.peer}` : `Message from ${message.peer}`,
          body: message.document ? message.document.filename : message.text,
        });
      }
    });
    return () => source.close();
  }, [session, notify]);

  const value = useMemo<SessionValue>(
    () => ({
      session,
      server,
      bridge,
      login,
      logout,
      call,
      run,
      onMessage: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      unread,
      setReading: (value) => {
        reading.current = value;
        if (value) setUnread(0);
      },
      toasts,
      notify,
      dismiss,
    }),
    [session, server, bridge, login, logout, call, run, unread, toasts, notify, dismiss],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** Load data once and on reload(); keeps the old data on screen while loading. */
export function useLoad<T>(load: (token: string) => Promise<T>, deps: unknown[]) {
  const { run } = useSession();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<BridgeError | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const result = await run(load);
      if (ticket === latest.current) {
        setData(result);
        setError(null);
      }
    } catch (caught) {
      if (ticket === latest.current) {
        setError(caught instanceof BridgeError ? caught : new BridgeError(String(caught), 0));
      }
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ...deps]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Load the result of one client-server action. */
export function useAction<T>(action: string, data: Record<string, unknown> = {}) {
  const key = JSON.stringify(data);
  return useLoad<T>((token) => api.call<T>(token, action, data), [action, key]);
}

/**
 * Keep a page's records fresh: reload when the section changes, when a
 * document arrives, when the server comes back, and every 20 seconds.
 */
export function useAutoRefresh(reload: () => void, section: string) {
  const { server, onMessage } = useSession();
  const latest = useRef(reload);
  latest.current = reload;
  const previousSection = useRef(section);
  const previousServer = useRef(server);

  useEffect(() => {
    if (previousSection.current !== section) latest.current();
    previousSection.current = section;
  }, [section]);

  useEffect(() => {
    if (previousServer.current === "offline" && server === "online") latest.current();
    previousServer.current = server;
  }, [server]);

  useEffect(() => onMessage((message) => message.document && latest.current()), [onMessage]);

  useEffect(() => {
    const timer = window.setInterval(() => latest.current(), 20_000);
    return () => window.clearInterval(timer);
  }, []);
}
