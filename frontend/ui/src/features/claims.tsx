import { Check, CircleDashed, Download, FileText, Paperclip, Send, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, cx, Field, Loading, Mono, Notice, Select, StatusBadge, Table, Textarea, Hash } from "../components/ui";
import { api, type Claim, type ClaimDocument, type Peer, type ReceivedFile, type Role, type SentDocument } from "../lib/api";
import { bytes, date, dateTime, money } from "../lib/format";
import { useAction, useLoad, useSession } from "../lib/session";
import { useErrorText } from "./policies";

export function ClaimTable({
  claims,
  selected,
  onSelect,
  empty,
  showCustomer = true,
  compact = false,
}: {
  claims: Claim[];
  compact?: boolean;
  selected?: string | null;
  onSelect: (claim: Claim) => void;
  empty: ReactNode;
  showCustomer?: boolean;
}) {
  const rows = [...claims].reverse();
  return (
    <Table
      rows={rows}
      rowKey={(c) => c.claim_no}
      selected={selected}
      onSelect={onSelect}
      empty={empty}
      columns={[
        { key: "no", header: "Claim", render: (c) => <Mono className="font-medium text-ink">{c.claim_no}</Mono> },
        ...(compact ? [] : [{ key: "policy", header: "Policy", render: (c: Claim) => <Mono className="text-ink-soft">{c.policy_no}</Mono> }]),
        ...(showCustomer ? [{ key: "customer", header: "Customer", render: (c: Claim) => `@${c.customer}` }] : []),
        ...(compact ? [] : [{ key: "filed", header: "Filed", render: (c: Claim) => <span className="text-[13px] text-ink-soft">{date(c.filed_at)}</span> }]),
        {
          key: "docs",
          header: "Docs",
          render: (c) => (
            <span className={cx("inline-flex items-center gap-1 text-[13px]", c.documents ? "text-ink" : "text-ink-faint")}>
              <Paperclip className="size-3.5" />
              {c.documents}
            </span>
          ),
        },
        { key: "amount", header: "Amount", align: "right", render: (c) => <span className="font-medium">{money(c.amount)}</span> },
        { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
      ]}
    />
  );
}

/** The right-hand panel for one claim. */
export function ClaimDetail({
  claim,
  role,
  sendTo,
  onChanged,
  onClose,
}: {
  claim: Claim;
  role: Role;
  sendTo?: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { onMessage } = useSession();
  const documents = useAction<ClaimDocument[]>("LIST_DOCUMENTS", { claim_no: claim.claim_no });
  const received = useLoad((token) => api.received(token), []);

  // a document that arrives while this panel is open shows at once
  const reloadDocs = useRef(documents.reload);
  const reloadReceived = useRef(received.reload);
  reloadDocs.current = documents.reload;
  reloadReceived.current = received.reload;
  useEffect(
    () =>
      onMessage((message) => {
        if (message.document) {
          reloadReceived.current();
          window.setTimeout(() => reloadDocs.current(), 600);
        }
      }),
    [onMessage],
  );

  return (
    <Card
      eyebrow="Claim"
      title={<Mono className="text-[15px] font-semibold text-ink">{claim.claim_no}</Mono>}
      actions={
        <>
          <StatusBadge status={claim.status} />
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-faint hover:bg-paper hover:text-ink" title="Close">
            <X className="size-4" />
          </button>
        </>
      }
      bodyClassName="space-y-6"
    >
      <div>
        <p className="num font-display text-[30px] leading-none font-medium">{money(claim.amount)}</p>
        <p className="mt-2 text-[13.5px] text-ink-soft">
          On <Mono>{claim.policy_no}</Mono> · @{claim.customer}
        </p>
        <blockquote className="mt-3 border-l-2 border-pine-200 pl-3 text-[14px] text-ink">{claim.description}</blockquote>
      </div>

      <Timeline claim={claim} />

      {role === "admin" && claim.status === "PENDING" && <DecideForm claim={claim} onDone={onChanged} />}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="eyebrow">Documents</h3>
          <span className="text-[12px] text-ink-faint">The server keeps only the checksum</span>
        </div>
        {documents.loading && !documents.data ? (
          <Loading label="Loading documents" />
        ) : documents.error ? (
          <Notice>{documents.error.message}</Notice>
        ) : (
          <DocumentList documents={documents.data ?? []} received={received.data ?? []} />
        )}
      </section>

      <SendDocumentForm
        claim={claim}
        defaultTo={sendTo}
        onSent={() => {
          documents.reload();
          onChanged();
        }}
      />
    </Card>
  );
}

function Timeline({ claim }: { claim: Claim }) {
  const decided = claim.status !== "PENDING";
  return (
    <ol className="relative space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-line-strong">
      <li className="relative">
        <span className="absolute top-1 -left-6 grid size-[15px] place-items-center rounded-full bg-pine-700 text-white">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
        <p className="text-[14px] font-medium">Filed by @{claim.customer}</p>
        <p className="text-[12.5px] text-ink-faint">{dateTime(claim.filed_at)}</p>
      </li>
      <li className="relative">
        {decided ? (
          <span
            className={cx(
              "absolute top-1 -left-6 grid size-[15px] place-items-center rounded-full text-white",
              claim.status === "APPROVED" ? "bg-moss-700" : "bg-brick-700",
            )}
          >
            {claim.status === "APPROVED" ? <Check className="size-2.5" strokeWidth={3} /> : <X className="size-2.5" strokeWidth={3} />}
          </span>
        ) : (
          <CircleDashed className="absolute top-1 -left-6 size-[15px] text-marigold-500" />
        )}
        {decided ? (
          <>
            <p className="text-[14px] font-medium">
              {claim.status === "APPROVED" ? "Approved" : "Rejected"} by @{claim.decided_by}
            </p>
            <p className="text-[12.5px] text-ink-faint">{dateTime(claim.decided_at)}</p>
            {claim.remarks && <p className="mt-1 text-[13.5px] text-ink-soft">“{claim.remarks}”</p>}
          </>
        ) : (
          <>
            <p className="text-[14px] font-medium">Waiting for a decision</p>
            <p className="text-[12.5px] text-ink-faint">The administrator approves or rejects the claim, one time only.</p>
          </>
        )}
      </li>
    </ol>
  );
}

function DocumentList({ documents, received }: { documents: ClaimDocument[]; received: ReceivedFile[] }) {
  const { session } = useSession();
  const me = session!.user.username;
  if (documents.length === 0) {
    return <p className="rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-[13.5px] text-ink-faint">No documents yet.</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {documents.map((doc) => {
        const copy = received.find((f) => f.sha256 === doc.sha256);
        const sameName = received.find((f) => f.filename === doc.filename && f.sha256 !== doc.sha256);
        let check: ReactNode = null;
        if (doc.sent_to === me) {
          check = copy ? (
            <Badge tone="moss"><ShieldCheck className="size-3.5" /> Verified copy</Badge>
          ) : sameName ? (
            <Badge tone="brick"><ShieldAlert className="size-3.5" /> Checksum differs</Badge>
          ) : (
            <Badge>Not on this computer</Badge>
          );
        } else if (doc.sent_by === me) {
          check = <Badge tone="pine">Sent by you</Badge>;
        }
        return (
          <li key={doc.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <FileText className="mt-0.5 size-5 shrink-0 text-pine-700" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{doc.filename}</p>
              <p className="text-[12.5px] text-ink-faint">
                {bytes(doc.size)} · @{doc.sent_by} → @{doc.sent_to} · {dateTime(doc.sent_at)}
              </p>
              <div className="mt-1"><Hash value={doc.sha256} /></div>
            </div>
            <div className="flex items-center gap-2">
              {check}
              {copy && session && (
                <a
                  href={api.receivedUrl(session.token, copy.filename)}
                  className="rounded-md p-1.5 text-ink-soft hover:bg-paper hover:text-ink"
                  title="Download your copy"
                >
                  <Download className="size-4" />
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function usePeers() {
  return useLoad((token) => api.peers(token), []);
}

function SendDocumentForm({ claim, defaultTo, onSent }: { claim: Claim; defaultTo?: string; onSent: () => void }) {
  const { run, notify } = useSession();
  const peers = usePeers();
  const [to, setTo] = useState(defaultTo ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SentDocument | null>(null);
  const { error, setError, fail } = useErrorText();
  const input = useRef<HTMLInputElement>(null);

  const list: Peer[] = peers.data?.peers ?? [];
  const target = to || defaultTo || list.find((p) => p.online)?.name || "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !target) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sent = await run((token) => api.sendDocument(token, target, claim.claim_no, file));
      setResult(sent);
      notify({ tone: "success", title: `${sent.sent.filename} sent to @${target}`, body: "Directly, peer to peer." });
      setFile(null);
      if (input.current) input.current.value = "";
      onSent();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-lg border border-line bg-paper/50 p-4">
      <p className="mb-3 flex items-center gap-2 text-[14px] font-medium">
        <Send className="size-4 text-pine-700" /> Send a document peer to peer
      </p>
      <div className="grid gap-3">
        <Field label="To">
          <Select value={target} onChange={(e) => setTo(e.target.value)}>
            {!target && <option value="">No one is online</option>}
            {defaultTo && !list.some((p) => p.name === defaultTo) && <option value={defaultTo}>@{defaultTo} (not online)</option>}
            {list.map((p) => (
              <option key={p.name} value={p.name}>
                @{p.name}
                {p.role ? ` · ${p.role}` : ""}
                {p.online === false ? " (offline)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">File</span>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line-strong bg-white px-3 py-2.5 transition hover:border-pine-600">
            <input ref={input} type="file" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-pine-100 text-pine-800">
              <Paperclip className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{file ? file.name : "Choose a file"}</span>
              <span className="block text-[12.5px] text-ink-faint">{file ? bytes(file.size) : "Medical report, receipt or photo · 50 MB at most"}</span>
            </span>
          </label>
        </div>
      </div>
      {error && <div className="mt-3"><Notice>{error}</Notice></div>}
      {result && (
        <div className="mt-3">
          <Notice tone={result.recorded ? "success" : "warning"}>
            <p>
              {result.recorded
                ? `Saved by @${target} as ${result.sent.saved_as}, and the checksum is recorded on ${claim.claim_no}.`
                : result.record_error}
            </p>
            <div className="mt-1"><Hash value={result.sent.sha256} full /></div>
          </Notice>
        </div>
      )}
      <div className="mt-3">
        <Button type="submit" busy={busy} disabled={!file || !target} icon={<Send className="size-4" />}>
          Send document
        </Button>
      </div>
    </form>
  );
}

function DecideForm({ claim, onDone }: { claim: Claim; onDone: () => void }) {
  const { call, notify } = useSession();
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);
  const { error, setError, fail } = useErrorText();

  const decide = async (decision: "APPROVED" | "REJECTED") => {
    setBusy(decision);
    setError(null);
    try {
      await call("DECIDE_CLAIM", { claim_no: claim.claim_no, decision, remarks: remarks || null });
      notify({ tone: "success", title: `${claim.claim_no} ${decision.toLowerCase()}` });
      onDone();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-marigold-100 bg-marigold-100/35 p-4">
      <p className="mb-3 text-[14px] font-medium">Decision</p>
      <Field label="Remarks (optional)">
        <Textarea value={remarks} maxLength={500} placeholder="For example: documents complete" onChange={(e) => setRemarks(e.target.value)} />
      </Field>
      {error && <div className="mt-3"><Notice>{error}</Notice></div>}
      <div className="mt-3 flex gap-2">
        <Button variant="approve" busy={busy === "APPROVED"} disabled={busy !== null} icon={<Check className="size-4" />} onClick={() => decide("APPROVED")}>
          Approve
        </Button>
        <Button variant="danger" busy={busy === "REJECTED"} disabled={busy !== null} icon={<X className="size-4" />} onClick={() => decide("REJECTED")}>
          Reject
        </Button>
      </div>
    </div>
  );
}
