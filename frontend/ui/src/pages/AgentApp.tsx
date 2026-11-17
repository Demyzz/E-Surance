import { FilePlus2, FileStack, MessagesSquare, ReceiptText, ScrollText, Users, Wallet } from "lucide-react";
import { useState } from "react";
import { Shell } from "../components/Shell";
import { Button, Card, EmptyState, Loading, Notice, PageHeader, Segmented, StatTile, Table } from "../components/ui";
import { ClaimDetail, ClaimTable } from "../features/claims";
import { MessagesView } from "../features/messages";
import { CreatePolicyForm, PayForm, PaymentTable, PolicyTable } from "../features/policies";
import type { Claim, ClaimStatus, Payment, Policy, UserRow } from "../lib/api";
import { date, moneyShort } from "../lib/format";
import { navigate } from "../lib/router";
import { useAction, useAutoRefresh, useSession } from "../lib/session";

export function AgentApp({ section, query }: { section: string; query: URLSearchParams }) {
  const { unread } = useSession();
  const customers = useAction<UserRow[]>("LIST_USERS");
  const policies = useAction<Policy[]>("LIST_POLICIES");
  const claims = useAction<Claim[]>("LIST_CLAIMS");
  const payments = useAction<Payment[]>("LIST_PAYMENTS");
  const reloadAll = () => {
    customers.reload();
    policies.reload();
    claims.reload();
    payments.reload();
  };

  const active = section || "customers";
  useAutoRefresh(reloadAll, active);
  const error = customers.error ?? policies.error ?? claims.error ?? payments.error;
  const pending = (claims.data ?? []).filter((c) => c.status === "PENDING").length;

  return (
    <Shell
      role="agent"
      active={active}
      sections={[
        { key: "customers", label: "Customers", icon: <Users /> },
        { key: "policies", label: "Policies", icon: <ScrollText /> },
        { key: "payments", label: "Payments", icon: <ReceiptText /> },
        { key: "claims", label: "Claims", icon: <FileStack />, badge: pending },
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

      {active === "customers" && (
        <>
          <PageHeader title="Customers" description="Every registered customer. Start a new policy for any of them." />
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
            <StatTile label="Customers" value={(customers.data ?? []).length} />
            <StatTile label="Your policies" value={(policies.data ?? []).length}
              detail={`${moneyShort((policies.data ?? []).reduce((s, p) => s + p.coverage, 0))} total coverage`} />
            <StatTile label="Claims waiting" accent="bg-marigold-500" value={pending} />
          </div>
          <Card bodyClassName="p-5">
            {customers.loading && !customers.data ? (
              <Loading label="Loading customers" />
            ) : (
              <Table
                rows={customers.data ?? []}
                rowKey={(c) => c.username}
                empty={<EmptyState icon={<Users className="size-5" />} title="No customers yet">Customers register from the customer portal.</EmptyState>}
                columns={[
                  { key: "name", header: "Name", render: (c) => <span className="font-medium">{c.full_name}</span> },
                  { key: "user", header: "Username", render: (c) => `@${c.username}` },
                  { key: "since", header: "Customer since", render: (c) => <span className="text-[13px] text-ink-soft">{date(c.created_at)}</span> },
                  {
                    key: "policies",
                    header: "Your policies",
                    align: "right",
                    render: (c) => (policies.data ?? []).filter((p) => p.customer === c.username).length,
                  },
                  {
                    key: "action",
                    header: "",
                    align: "right",
                    render: (c) => (
                      <Button size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />}
                        onClick={() => navigate(`/agent/policies?customer=${c.username}`)}>
                        New policy
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </>
      )}

      {active === "policies" && (
        <>
          <PageHeader title="Policies" description="The policies you made. A new policy starts today and is ACTIVE." />
          <Card title="New policy" className="mb-6">
            {customers.data ? (
              <CreatePolicyForm key={query.get("customer") ?? ""} customers={customers.data} customer={query.get("customer") ?? undefined}
                onCreated={reloadAll} />
            ) : (
              <Loading />
            )}
          </Card>
          <Card title="Policies of your customers" bodyClassName="p-5">
            <PolicyTable policies={policies.data ?? []} empty={<EmptyState icon={<ScrollText className="size-5" />} title="No policies yet" />} />
          </Card>
        </>
      )}

      {active === "payments" && (
        <>
          <PageHeader title="Payments" description="Record a premium that a customer paid to you." />
          <div className="grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Card title="Record a payment">{policies.data ? <PayForm policies={policies.data} onDone={reloadAll} /> : <Loading />}</Card>
            <Card title="Payments of your customers" bodyClassName="p-5">
              <PaymentTable payments={payments.data ?? []} empty={<EmptyState icon={<Wallet className="size-5" />} title="No payments yet" />} />
            </Card>
          </div>
        </>
      )}

      {active === "claims" && (
        <ClaimsSection claims={claims.data ?? []} loading={claims.loading && !claims.data} selected={query.get("claim")} onChanged={reloadAll}
          role="agent" description="Claims on the policies of your customers. Documents that customers send you are checked against the recorded checksum." />
      )}

      {active === "messages" && <MessagesView />}
    </Shell>
  );
}

export function ClaimsSection({
  claims,
  loading,
  selected,
  onChanged,
  role,
  description,
}: {
  claims: Claim[];
  loading: boolean;
  selected: string | null;
  onChanged: () => void;
  role: "agent" | "admin";
  description: string;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClaimStatus | "ALL">(role === "admin" ? "PENDING" : "ALL");
  const current = picked ?? selected;
  const claim = current ? claims.find((c) => c.claim_no === current) ?? null : null;
  const shown = filter === "ALL" ? claims : claims.filter((c) => c.status === filter);
  const count = (status: ClaimStatus) => claims.filter((c) => c.status === status).length;

  return (
    <>
      <PageHeader title="Claims" description={description} />
      <div className="mb-4">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "ALL", label: `All ${claims.length}` },
            { value: "PENDING", label: `Pending ${count("PENDING")}` },
            { value: "APPROVED", label: `Approved ${count("APPROVED")}` },
            { value: "REJECTED", label: `Rejected ${count("REJECTED")}` },
          ]}
        />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Card bodyClassName="p-5">
          {loading ? (
            <Loading label="Loading claims" />
          ) : (
            <ClaimTable
              claims={shown}
              selected={claim?.claim_no}
              compact={!!claim}
              onSelect={(c) => setPicked(c.claim_no)}
              empty={<EmptyState icon={<FileStack className="size-5" />} title="No claims here" />}
            />
          )}
        </Card>
        {claim && (
          <ClaimDetail key={claim.claim_no} claim={claim} role={role} sendTo={role === "agent" ? claim.customer : undefined}
            onChanged={onChanged} onClose={() => setPicked("")} />
        )}
      </div>
    </>
  );
}
