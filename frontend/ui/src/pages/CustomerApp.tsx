import { FileStack, LayoutDashboard, MessagesSquare, ReceiptText, ShieldCheck, Wallet } from "lucide-react";
import { useState } from "react";
import { Shell } from "../components/Shell";
import { Card, EmptyState, Loading, Mono, Notice, PageHeader, StatTile, StatusBadge } from "../components/ui";
import { ClaimDetail, ClaimTable } from "../features/claims";
import { MessagesView } from "../features/messages";
import { cardGrid, PayForm, PaymentTable, PolicyCard } from "../features/policies";
import type { Claim, Payment, Policy } from "../lib/api";
import { date, firstName, greeting, money, moneyShort, plural } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useAction, useAutoRefresh, useSession } from "../lib/session";

export function CustomerApp({ section, query }: { section: string; query: URLSearchParams }) {
  const { session, unread } = useSession();
  const policies = useAction<Policy[]>("LIST_POLICIES");
  const claims = useAction<Claim[]>("LIST_CLAIMS");
  const payments = useAction<Payment[]>("LIST_PAYMENTS");
  const reloadAll = () => {
    policies.reload();
    claims.reload();
    payments.reload();
  };

  const active = section || "overview";
  useAutoRefresh(reloadAll, active);
  const error = policies.error ?? claims.error ?? payments.error;

  return (
    <Shell
      role="customer"
      active={active}
      sections={[
        { key: "overview", label: "My policies", icon: <LayoutDashboard /> },
        { key: "claims", label: "Claims", icon: <FileStack /> },
        { key: "payments", label: "Payments", icon: <ReceiptText /> },
        { key: "messages", label: "Messages", icon: <MessagesSquare />, badge: unread },
      ]}
    >
      {error && active !== "messages" && (
        <div className="mb-6">
          <Notice tone={error.serverDown ? "warning" : "error"}>
            {error.serverDown ? "Your records cannot load while the server is offline." : error.message}
          </Notice>
        </div>
      )}

      {active === "overview" && (
        <>
          <PageHeader
            title={`${greeting()}, ${firstName(session!.user.full_name)}`}
            description="These are your policies with E-Surance. Pay a premium or file a claim from the policy itself."
          />
          <div className="mb-8 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <StatTile label="Active policies" value={(policies.data ?? []).filter((p) => p.status === "ACTIVE").length} />
            <StatTile label="Total coverage" value={moneyShort((policies.data ?? []).reduce((sum, p) => sum + p.coverage, 0))} />
            <StatTile
              label="Open claims"
              accent="bg-marigold-500"
              value={(claims.data ?? []).filter((c) => c.status === "PENDING").length}
              detail={`${plural((claims.data ?? []).length, "claim")} in all`}
            />
            <StatTile label="Premiums paid" accent="bg-moss-700" value={moneyShort((payments.data ?? []).reduce((sum, p) => sum + p.amount, 0))}
              detail={plural((payments.data ?? []).length, "payment")} />
          </div>

          {policies.loading && !policies.data ? (
            <Loading label="Loading your policies" />
          ) : (policies.data ?? []).length === 0 ? (
            <Card>
              <EmptyState icon={<ShieldCheck className="size-5" />} title="No policies yet">
                Your agent creates your policy. When it is ready, it shows here.
              </EmptyState>
            </Card>
          ) : (
            <div className={cardGrid}>
              {(policies.data ?? []).map((policy) => (
                <PolicyCard key={policy.policy_no} policy={policy} onChanged={reloadAll} />
              ))}
            </div>
          )}

          {(claims.data ?? []).length > 0 && (
            <Card className="mt-8" title="Recent claims" actions={<Link to="/customer/claims" className="text-[13.5px] font-medium text-pine-700 hover:underline">All claims</Link>}>
              <ul className="-my-2 divide-y divide-line">
                {[...(claims.data ?? [])].reverse().slice(0, 3).map((claim) => (
                  <li key={claim.claim_no}>
                    <button
                      type="button"
                      onClick={() => navigate(`/customer/claims?claim=${claim.claim_no}`)}
                      className="flex w-full flex-wrap items-center gap-3 py-3 text-left hover:bg-pine-50/50"
                    >
                      <Mono className="font-medium">{claim.claim_no}</Mono>
                      <span className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">{claim.description}</span>
                      <span className="num text-[14px] font-medium">{money(claim.amount)}</span>
                      <StatusBadge status={claim.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {active === "claims" && (
        <ClaimsSection claims={claims.data ?? []} policies={policies.data ?? []} loading={claims.loading && !claims.data}
          selected={query.get("claim")} onChanged={reloadAll} />
      )}

      {active === "payments" && (
        <>
          <PageHeader title="Payments" description="Each payment gets its own reference number from the server." />
          <div className="grid items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Card title="Pay a premium">
              {policies.data ? <PayForm policies={policies.data} onDone={reloadAll} /> : <Loading />}
            </Card>
            <Card title="Payment history" bodyClassName="p-5">
              <PaymentTable
                payments={payments.data ?? []}
                empty={<EmptyState icon={<Wallet className="size-5" />} title="No payments yet" />}
              />
            </Card>
          </div>
        </>
      )}

      {active === "messages" && <MessagesView />}
    </Shell>
  );
}

function ClaimsSection({
  claims,
  policies,
  loading,
  selected,
  onChanged,
}: {
  claims: Claim[];
  policies: Policy[];
  loading: boolean;
  selected: string | null;
  onChanged: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = picked ?? selected;
  const claim = current ? claims.find((c) => c.claim_no === current) ?? null : null;
  const agentOf = (c: Claim) => policies.find((p) => p.policy_no === c.policy_no)?.agent;

  return (
    <>
      <PageHeader
        title="Claims"
        description="Choose a claim to see its decision and to send documents, such as a medical report, directly to your agent."
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
        <Card bodyClassName="p-5">
          {loading ? (
            <Loading label="Loading your claims" />
          ) : (
            <ClaimTable
              claims={claims}
              selected={claim?.claim_no}
              compact={!!claim}
              showCustomer={false}
              onSelect={(c) => setPicked(c.claim_no)}
              empty={
                <EmptyState icon={<FileStack className="size-5" />} title="No claims yet">
                  File a claim from one of your policies on the My policies page.
                </EmptyState>
              }
            />
          )}
        </Card>
        {claim ? (
          <ClaimDetail key={claim.claim_no} claim={claim} role="customer" sendTo={agentOf(claim)} onChanged={onChanged} onClose={() => setPicked("")} />
        ) : (
          claims.length > 0 && (
            <div className="hidden rounded-xl border border-dashed border-line-strong p-8 text-center text-[14px] text-ink-faint xl:block">
              Choose a claim to see it here.
              <p className="mt-1 text-[12.5px]">Filed {date(claims[claims.length - 1].filed_at)} was your last claim.</p>
            </div>
          )
        )}
      </div>
    </>
  );
}
