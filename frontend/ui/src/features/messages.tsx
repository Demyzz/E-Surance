import { Download, FileText, Inbox, MessagesSquare, RefreshCw, Send } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { roleLabel } from "../components/Shell";
import { Button, Card, cx, EmptyState, Hash, Notice, PageHeader } from "../components/ui";
import { api, type Message } from "../lib/api";
import { bytes, dateTime, time } from "../lib/format";
import { useLoad, useSession } from "../lib/session";
import { usePeers } from "./claims";

export function MessagesView() {
  const { run, onMessage, setReading, session, server } = useSession();
  const peers = usePeers();
  const reloadPeers = useRef(peers.reload);
  reloadPeers.current = peers.reload;
  useEffect(() => {
    reloadPeers.current();   // who is online changes with the server
  }, [server]);
  const history = useLoad((token) => api.messages(token), []);
  const received = useLoad((token) => api.received(token), []);
  const [live, setLive] = useState<Message[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReading(true);
    return () => setReading(false);
  }, [setReading]);

  const reloadReceived = useRef(received.reload);
  reloadReceived.current = received.reload;
  useEffect(
    () =>
      onMessage((message) => {
        setLive((all) => [...all, message]);
        if (message.document) reloadReceived.current();
      }),
    [onMessage],
  );

  const messages = useMemo(() => {
    const byId = new Map<number, Message>();
    for (const m of [...(history.data ?? []), ...live]) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }, [history.data, live]);

  // everyone in the peer table, plus anyone who wrote to us
  const people = useMemo(() => {
    const list = new Map<string, { name: string; role: string | null; online: boolean | null; last?: Message }>();
    for (const p of peers.data?.peers ?? []) list.set(p.name, { name: p.name, role: p.role, online: p.online });
    for (const m of messages) {
      const entry = list.get(m.peer) ?? { name: m.peer, role: null, online: null };
      entry.last = m;
      list.set(m.peer, entry);
    }
    return [...list.values()].sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0) || a.name.localeCompare(b.name));
  }, [peers.data, messages]);

  const current = selected ?? people[0]?.name ?? null;
  const thread = messages.filter((m) => m.peer === current);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.length, current]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!current || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await run((token) => api.sendMessage(token, current, text.trim()));
      setLive((all) => [...all, sent]);
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const serverOffline = peers.data?.server === "offline";

  return (
    <>
      <PageHeader
        title="Messages"
        description="Messages and documents go directly to the other person's computer. The server only tells you where they are."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw className="size-4" />} busy={peers.loading} onClick={peers.reload}>
            Refresh
          </Button>
        }
      />

      <div className="card grid min-h-[480px] overflow-hidden lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-paper/40 lg:border-r lg:border-b-0">
          <p className="eyebrow px-4 pt-4 pb-2">{serverOffline ? "Your peer table (server offline)" : "People"}</p>
          {people.length === 0 ? (
            <p className="px-4 pb-4 text-[13.5px] text-ink-faint">No one else is online yet.</p>
          ) : (
            <ul className="flex gap-1 overflow-x-auto px-2 pb-3 lg:flex-col lg:overflow-visible">
              {people.map((person) => (
                <li key={person.name} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelected(person.name)}
                    className={cx(
                      "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition",
                      current === person.name ? "bg-white shadow-sm ring-1 ring-line" : "hover:bg-white/70",
                    )}
                  >
                    <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-pine-100 font-display text-[15px] font-semibold text-pine-800 uppercase">
                      {person.name.charAt(0)}
                      <span
                        className={cx(
                          "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-white",
                          person.online ? "bg-moss-700" : person.online === false ? "bg-line-strong" : "bg-marigold-500",
                        )}
                      />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium">@{person.name}</span>
                      <span className="block truncate text-[12.5px] text-ink-faint">
                        {person.last
                          ? person.last.document
                            ? person.last.document.filename
                            : person.last.text
                          : person.role
                            ? roleLabel[person.role as keyof typeof roleLabel]
                            : "Peer"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="flex min-h-[420px] flex-col">
          {current ? (
            <>
              <header className="border-b border-line px-5 py-3">
                <p className="font-medium">@{current}</p>
                <p className="text-[12.5px] text-ink-faint">Direct TCP connection for each message · no server in between</p>
              </header>
              <div className="flex-1 space-y-3 overflow-y-auto bg-paper/35 px-5 py-5">
                {thread.length === 0 && (
                  <EmptyState icon={<MessagesSquare className="size-5" />} title="No messages yet">
                    Say hello. The message goes straight to @{current}.
                  </EmptyState>
                )}
                {thread.map((m) => (
                  <Bubble key={m.id} message={m} token={session!.token} received={received.data ?? []} />
                ))}
                <div ref={bottom} />
              </div>
              <form onSubmit={send} className="border-t border-line p-3">
                {error && <div className="mb-2"><Notice>{error}</Notice></div>}
                <div className="flex gap-2">
                  <input
                    value={text}
                    maxLength={2000}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={`Message @${current}`}
                    className="field"
                  />
                  <Button type="submit" busy={busy} disabled={!text.trim()} icon={<Send className="size-4" />}>
                    Send
                  </Button>
                </div>
              </form>
            </>
          ) : (
            <div className="grid flex-1 place-items-center">
              <EmptyState icon={<MessagesSquare className="size-5" />} title="Nobody to talk to yet">
                When another user logs in, the server directory shows them here.
              </EmptyState>
            </div>
          )}
        </section>
      </div>

      <Card className="mt-6" title="Received documents" eyebrow="On this computer">
        {(received.data ?? []).length === 0 ? (
          <EmptyState icon={<Inbox className="size-5" />} title="No documents received">
            Documents that other users send you are saved here, after the checksum check.
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-line">
            {(received.data ?? []).map((f) => (
              <li key={f.filename} className="flex flex-wrap items-center gap-3 py-3">
                <FileText className="size-5 text-pine-700" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{f.filename}</p>
                  <p className="text-[12.5px] text-ink-faint">
                    {bytes(f.size)}
                    {f.from && ` · from @${f.from}`}
                    {f.at && ` · ${dateTime(f.at)}`}
                  </p>
                </div>
                <Hash value={f.sha256} />
                <a href={api.receivedUrl(session!.token, f.filename)} className="rounded-md p-1.5 text-ink-soft hover:bg-paper hover:text-ink" title="Download">
                  <Download className="size-4" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Bubble({ message, token, received }: { message: Message; token: string; received: { filename: string; sha256: string }[] }) {
  const out = message.direction === "out";
  const copy = message.document && !out ? received.find((f) => f.sha256 === message.document!.sha256) : undefined;
  return (
    <div className={cx("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "max-w-[78%] rounded-2xl px-4 py-2.5 text-[14.5px]",
          out ? "rounded-br-md bg-pine-800 text-white" : "rounded-bl-md border border-line bg-white text-ink",
        )}
      >
        {message.document ? (
          <div className="flex items-start gap-2.5">
            <FileText className={cx("mt-0.5 size-5 shrink-0", out ? "text-pine-200" : "text-pine-700")} />
            <div className="min-w-0">
              <p className="truncate font-medium">{message.document.filename}</p>
              <p className={cx("text-[12.5px]", out ? "text-pine-100/80" : "text-ink-faint")}>
                {bytes(message.document.size)}
                {message.claim_no && ` · for ${message.claim_no}`}
              </p>
              <p className={cx("mt-1 font-mono text-[11.5px]", out ? "text-pine-100/70" : "text-ink-faint")}>
                SHA-256 {message.document.sha256.slice(0, 16)}…
              </p>
              {copy && (
                <a href={api.receivedUrl(token, copy.filename)} className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-pine-700 hover:underline">
                  <Download className="size-3.5" /> Download
                </a>
              )}
            </div>
          </div>
        ) : (
          <p className="break-words whitespace-pre-wrap">{message.text}</p>
        )}
        <p className={cx("mt-1 text-right text-[11px]", out ? "text-pine-100/60" : "text-ink-faint")}>{time(message.at)}</p>
      </div>
    </div>
  );
}
