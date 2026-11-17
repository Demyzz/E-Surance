import { FileStack, LayoutDashboard, MessagesSquare, ReceiptText, ScrollText, UserPlus, Users, Wallet } from "lucide-react";
import { type FormEvent, useState } from "react";
import { roleLabel, Shell } from "../components/Shell";
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Mono, Notice, PageHeader, Segmented, Select, StatTile, Table } from "../components/ui";
import { MessagesView } from "../features/messages";
import { CreatePolicyForm, PaymentTable, PolicyTable, useErrorText } from "../features/policies";
import type { Claim, Payment, Policy, Role, Summary, UserRow } from "../lib/api";
import { date, money, moneyShort, plural } from "../lib/format";
import { navigate } from "../lib/router";
import { useAction, useAutoRefresh, useSession } from "../lib/session";
import { ClaimsSection } from "./AgentApp";

export function AdminApp({ section, query }: { section: string; query: URLSearchParams }) {
  const { unread } = useSession();
  const summary = useAction<Summary>("SUMMARY");
  const users = useAction<UserRow[]>("LIST_USERS");
  const policies = useAction<Policy[]>("LIST_POLICIES");
  const claims = useAction<Claim[]>("LIST_CLAIMS");
  const payments = useAction<Payment[]>("LIST_PAYMENTS");
  const reloadAll = () => {
    summary.reload();
    users.reload();
    policies.reload();
    claims.reload();
    payments.reload();
  };

  const active = section || "overview";
  useAutoRefresh(reloadAll, active);
  const error = summary.error ?? users.error ?? policies.error ?? claims.error ?? payments.error;
  const pending = summary.data?.claims.PENDING ?? 0;

  return (
    <Shell
      role="admin"
      active={active}
      sections={[
        { key: "overview", label: "Overview", icon: <LayoutDashboard /> },
        { key: "claims", label: "Claims", icon: <FileStack />, badge: pending },
        { key: "users", label: "Accounts", icon: <Users /> },
        { key: "policies", label: "Policies", icon: <ScrollText /> },
        { key: "payments", label: "Payments", icon: <ReceiptText /> },
        { key: "messages", label: "Messages", icon: <MessagesSquare />, badge: unread },
      ]}
    >
      {error && active !== "messages" && (
        <div className="mb-6">
          <Notice tone={error.serverDown ? "warning" : "error"}>
            {error.serverDown ? "Records cannot load while the server is offline." : error.message}
          </Notice>
        </div>
      )}

      {active === "overview" && (
        <Overview summary={summary.data} claims={claims.data ?? []} loading={summary.loading && !summary.data} />
      )}

      {active === "claims" && (
        <ClaimsSection claims={claims.data ?? []} loading={claims.loading && !claims.data} selected={query.get("claim")} onChanged={reloadAll}
          role="admin" description="Approve or reject each claim. A claim gets only one decision." />
      )}

      {active === "users" && <Accounts users={users.data} onCreated={reloadAll} />}

      {active === "policies" && (
        <>
          <PageHeader title="Policies" description="Every policy in the system." />
          <Card title="New policy" className="mb-6">
            {users.data ? (
              <CreatePolicyForm customers={users.data.filter((u) => u.role === "customer")} onCreated={reloadAll} />
            ) : (
              <Loading />
            )}
          </Card>
          <Card title="All policies" bodyClassName="p-5">
            <PolicyTable policies={policies.data ?? []} empty={<EmptyState icon={<ScrollText className="size-5" />} title="No policies yet" />} />
          </Card>
        </>
      )}

      {active === "payments" && (
        <>
          <PageHeader title="Payments" description="Every premium payment, newest first." />
          <Card bodyClassName="p-5">
            <PaymentTable payments={payments.data ?? []} empty={<EmptyState icon={<Wallet className="size-5" />} title="No payments yet" />} />
          </Card>
        </>
      )}

      {active === "messages" && <MessagesView />}
    </Shell>
  );
}

function Overview({ summary, claims, loading }: { summary?: Summary; claims: Claim[]; loading: boolean }) {
  if (loading || !summary) return <Loading label="Loading the summary report" />;
  const { users, policies, payments, claims: c } = summary;
  const decided = c.PENDING + c.APPROVED + c.REJECTED;
  const pendingClaims = claims.filter((claim) => claim.status === "PENDING");

  return (
    <>
      <PageHeader title="Summary report" description="The totals for all records, from the one database on the server." />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatTile label="Accounts" value={users.customer + users.agent + users.admin}
          detail={`${plural(users.customer, "customer")} · ${plural(users.agent, "agent")} · ${plural(users.admin, "admin")}`} />
        <StatTile label="Policies" value={policies.count} detail={`${policies.active} active · ${moneyShort(policies.total_coverage)} coverage`} />
        <StatTile label="Premiums collected" accent="bg-moss-700" value={moneyShort(payments.total)} detail={plural(payments.count, "payment")} />
        <StatTile label="Documents recorded" accent="bg-pine-600" value={summary.documents} detail="Moved peer to peer; checksum kept here" />
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card title="Claims" eyebrow={`${decided} filed`}>
          <div className="flex h-3 overflow-hidden rounded-full bg-paper-deep">
            {decided > 0 && (
              <>
                <span className="bg-marigold-500" style={{ width: `${(c.PENDING / decided) * 100}%` }} />
                <span className="bg-moss-700" style={{ width: `${(c.APPROVED / decided) * 100}%` }} />
                <span className="bg-brick-700" style={{ width: `${(c.REJECTED / decided) * 100}%` }} />
              </>
            )}
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3 text-[13.5px]">
            {[
              ["Pending", c.PENDING, "bg-marigold-500"],
              ["Approved", c.APPROVED, "bg-moss-700"],
              ["Rejected", c.REJECTED, "bg-brick-700"],
            ].map(([label, value, dot]) => (
              <div key={label as string}>
                <dt className="flex items-center gap-1.5 text-ink-faint">
                  <span className={`size-2 rounded-full ${dot}`} /> {label}
                </dt>
                <dd className="num mt-0.5 font-display text-[24px] font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-[13.5px]">
            <div className="flex justify-between"><dt className="text-ink-soft">Amount claimed</dt><dd className="num font-medium">{money(c.total_claimed)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-soft">Amount approved</dt><dd className="num font-medium text-moss-700">{money(c.total_approved)}</dd></div>
          </dl>
        </Card>

        <Card title="Waiting for your decision" eyebrow={`${pendingClaims.length} pending`}>
          {pendingClaims.length === 0 ? (
            <EmptyState icon={<FileStack className="size-5" />} title="No claims are waiting" />
          ) : (
            <ul className="-my-2 divide-y divide-line">
              {pendingClaims.map((claim) => (
                <li key={claim.claim_no} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <Mono className="font-medium">{claim.claim_no}</Mono>
                      <span className="text-[13px] text-ink-faint">@{claim.customer} · {date(claim.filed_at)}</span>
                    </p>
                    <p className="truncate text-[13.5px] text-ink-soft">{claim.description}</p>
                  </div>
                  <span className="num text-[14px] font-medium">{money(claim.amount)}</span>
                  <Button size="sm" variant="secondary" onClick={() => navigate(`/admin/claims?claim=${claim.claim_no}`)}>Review</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function Accounts({ users, onCreated }: { users?: UserRow[]; onCreated: () => void }) {
  const [filter, setFilter] = useState<Role | "all">("all");
  const shown = (users ?? []).filter((u) => filter === "all" || u.role === filter);
  return (
    <>
      <PageHeader title="Accounts" description="Customers register by themselves. Only the administrator makes agent and administrator accounts." />
      <div className="grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card title="Make an account">
          <CreateUserForm onCreated={onCreated} />
        </Card>
        <Card title="All accounts" actions={
          <Segmented value={filter} onChange={setFilter} options={[
            { value: "all", label: "All" },
            { value: "customer", label: "Customers" },
            { value: "agent", label: "Agents" },
            { value: "admin", label: "Admins" },
          ]} />
        } bodyClassName="p-5">
          {!users ? (
            <Loading />
          ) : (
            <Table
              rows={shown}
              rowKey={(u) => u.username}
              empty={<EmptyState icon={<Users className="size-5" />} title="No accounts" />}
              columns={[
                { key: "name", header: "Name", render: (u) => <span className="font-medium">{u.full_name}</span> },
                { key: "user", header: "Username", render: (u) => `@${u.username}` },
                { key: "role", header: "Role", render: (u) => <Badge tone={u.role === "admin" ? "brick" : u.role === "agent" ? "pine" : "neutral"}>{roleLabel[u.role]}</Badge> },
                { key: "since", header: "Created", render: (u) => <span className="text-[13px] text-ink-soft">{date(u.created_at)}</span> },
              ]}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const { call, notify } = useSession();
  const [form, setForm] = useState({ username: "", full_name: "", role: "agent" as Role, password: "" });
  const [busy, setBusy] = useState(false);
  const { error, setError, fail } = useErrorText();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await call<UserRow>("CREATE_USER", form);
      notify({ tone: "success", title: `${roleLabel[user.role]} account @${user.username} made` });
      setForm({ username: "", full_name: "", role: form.role, password: "" });
      onCreated();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <Field label="Full name"><Input required value={form.full_name} onChange={set("full_name")} /></Field>
      <Field label="Username" hint="3 to 20 letters, digits, or _"><Input required value={form.username} onChange={set("username")} /></Field>
      <Field label="Role">
        <Select value={form.role} onChange={set("role")}>
          <option value="agent">Agent</option>
          <option value="admin">Administrator</option>
          <option value="customer">Customer</option>
        </Select>
      </Field>
      <Field label="Password" hint="6 characters or more"><Input required type="password" autoComplete="new-password" value={form.password} onChange={set("password")} /></Field>
      {error && <Notice>{error}</Notice>}
      <Button type="submit" busy={busy} icon={<UserPlus className="size-4" />}>Make account</Button>
    </form>
  );
}
