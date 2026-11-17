import { Car, FilePlus2, HeartHandshake, HeartPulse, House, Wallet } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button, cx, Field, Input, Mono, Notice, Segmented, Select, StatusBadge, Table, Textarea } from "../components/ui";
import type { Claim, Payment, Policy, PolicyType, UserRow } from "../lib/api";
import { date, money, moneyShort, termProgress } from "../lib/format";
import { useSession } from "../lib/session";

export const policyTypes: { value: PolicyType; label: string; icon: ReactNode }[] = [
  { value: "LIFE", label: "Life", icon: <HeartHandshake className="size-4" /> },
  { value: "HEALTH", label: "Health", icon: <HeartPulse className="size-4" /> },
  { value: "MOTOR", label: "Motor", icon: <Car className="size-4" /> },
  { value: "PROPERTY", label: "Property", icon: <House className="size-4" /> },
];

export const typeIcon = (type: PolicyType) => policyTypes.find((t) => t.value === type)?.icon;

export function useErrorText() {
  const [error, setError] = useState<string | null>(null);
  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));
  return { error, setError, fail };
}

// -- the customer's policy card ---------------------------------------------

export function PolicyCard({ policy, onChanged }: { policy: Policy; onChanged: () => void }) {
  const [open, setOpen] = useState<"pay" | "claim" | null>(null);
  const progress = termProgress(policy.start_date, policy.end_date);
  const active = policy.status === "ACTIVE";

  return (
    <article className="card flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-dashed border-line-strong bg-paper/60 px-5 py-3">
        <span className="flex items-center gap-2 text-pine-800">
          {typeIcon(policy.policy_type)}
          <span className="text-[12px] font-semibold tracking-[0.14em] uppercase">{policy.policy_type} insurance</span>
        </span>
        <StatusBadge status={policy.status} />
      </div>

      <div className="flex-1 px-5 pt-4 pb-5">
        <Mono className="text-ink-faint">{policy.policy_no}</Mono>
        <p className="num mt-1 font-display text-[34px] leading-none font-medium text-ink">{moneyShort(policy.coverage)}</p>
        <p className="mt-1 text-[13px] text-ink-soft">coverage</p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13.5px]">
          <dt className="text-ink-faint">Premium</dt>
          <dd className="num text-right font-medium">{money(policy.premium)}</dd>
          <dt className="text-ink-faint">Agent</dt>
          <dd className="text-right font-medium">@{policy.agent}</dd>
        </dl>

        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full rounded-full bg-pine-600" style={{ width: `${Math.max(progress * 100, 2)}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] text-ink-faint">
            <span>{date(policy.start_date)}</span>
            <span>until {date(policy.end_date)}</span>
          </div>
        </div>
      </div>

      {open === null ? (
        <footer className="flex gap-2 border-t border-line px-5 py-3">
          <Button size="sm" icon={<Wallet className="size-4" />} disabled={!active} onClick={() => setOpen("pay")}>
            Pay premium
          </Button>
          <Button size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />} disabled={!active} onClick={() => setOpen("claim")}>
            File a claim
          </Button>
        </footer>
      ) : (
        <footer className="border-t border-line bg-paper/40 px-5 py-4">
          {open === "pay" ? (
            <PayForm policies={[policy]} onDone={() => { setOpen(null); onChanged(); }} onCancel={() => setOpen(null)} />
          ) : (
            <ClaimForm policy={policy} onDone={() => { setOpen(null); onChanged(); }} onCancel={() => setOpen(null)} />
          )}
        </footer>
      )}
    </article>
  );
}

// -- forms -------------------------------------------------------------------

export function PayForm({
  policies,
  onDone,
  onCancel,
}: {
  policies: Policy[];
  onDone: (payment: Payment) => void;
  onCancel?: () => void;
}) {
  const { call, notify } = useSession();
  const active = policies.filter((p) => p.status === "ACTIVE");
  const [policyNo, setPolicyNo] = useState(active[0]?.policy_no ?? "");
  const policy = active.find((p) => p.policy_no === policyNo);
  const [amount, setAmount] = useState(policy ? String(policy.premium) : "");
  const [busy, setBusy] = useState(false);
  const { error, setError, fail } = useErrorText();

  if (active.length === 0) return <Notice tone="info">There is no active policy to pay.</Notice>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payment = await call<Payment>("PAY_PREMIUM", { policy_no: policyNo, amount: Number(amount) });
      notify({ tone: "success", title: `Payment ${payment.reference} recorded`, body: `${money(payment.amount)} on ${payment.policy_no}` });
      onDone(payment);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {active.length > 1 && (
        <Field label="Policy">
          <Select
            value={policyNo}
            onChange={(e) => {
              setPolicyNo(e.target.value);
              const next = active.find((p) => p.policy_no === e.target.value);
              if (next) setAmount(String(next.premium));
            }}
          >
            {active.map((p) => (
              <option key={p.policy_no} value={p.policy_no}>
                {p.policy_no} · {p.policy_type} · @{p.customer}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Amount (₱)" hint={policy ? `The premium is ${money(policy.premium)}.` : undefined}>
        <Input type="number" min="0.01" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {error && <Notice>{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy} icon={<Wallet className="size-4" />}>
          Pay {amount ? money(Number(amount) || 0) : ""}
        </Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

export function ClaimForm({ policy, onDone, onCancel }: { policy: Policy; onDone: (claim: Claim) => void; onCancel?: () => void }) {
  const { call, notify } = useSession();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const { error, setError, fail } = useErrorText();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const claim = await call<Claim>("FILE_CLAIM", { policy_no: policy.policy_no, description, amount: Number(amount) });
      notify({ tone: "success", title: `Claim ${claim.claim_no} filed`, body: "Send the documents to your agent from Claims." });
      onDone(claim);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="What happened?">
        <Textarea required maxLength={500} value={description} placeholder="For example: hospital confinement, 3 days"
          onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Amount claimed (₱)" hint={`Up to the coverage of ${money(policy.coverage)}.`}>
        <Input type="number" min="0.01" step="0.01" max={policy.coverage} required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      {error && <Notice>{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy} icon={<FilePlus2 className="size-4" />}>File claim</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

export function CreatePolicyForm({
  customers,
  customer: initialCustomer,
  onCreated,
}: {
  customers: UserRow[];
  customer?: string;
  onCreated: (policy: Policy) => void;
}) {
  const { call, notify } = useSession();
  const [customer, setCustomer] = useState(initialCustomer ?? customers[0]?.username ?? "");
  const [type, setType] = useState<PolicyType>("LIFE");
  const [coverage, setCoverage] = useState("500000");
  const [premium, setPremium] = useState("1200");
  const [term, setTerm] = useState("12");
  const [busy, setBusy] = useState(false);
  const { error, setError, fail } = useErrorText();

  const premiumTooHigh = Number(premium) >= Number(coverage) && coverage !== "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const policy = await call<Policy>("CREATE_POLICY", {
        customer,
        policy_type: type,
        coverage: Number(coverage),
        premium: Number(premium),
        term_months: Number(term),
      });
      notify({ tone: "success", title: `Policy ${policy.policy_no} created`, body: `${policy.policy_type} for @${policy.customer}, until ${date(policy.end_date)}` });
      onCreated(policy);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  if (customers.length === 0) {
    return <Notice tone="info">No customers yet. A customer registers first, from the customer page.</Notice>;
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="Customer" className="sm:col-span-2">
        <Select value={customer} onChange={(e) => setCustomer(e.target.value)}>
          {customers.map((c) => (
            <option key={c.username} value={c.username}>
              {c.full_name} (@{c.username})
            </option>
          ))}
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">Type of insurance</span>
        <Segmented value={type} onChange={setType}
          options={policyTypes.map((t) => ({ value: t.value, label: <>{t.icon}{t.label}</> }))} />
      </div>
      <Field label="Coverage (₱)">
        <Input type="number" min="1" step="0.01" required value={coverage} onChange={(e) => setCoverage(e.target.value)} />
      </Field>
      <Field label="Premium (₱)" hint={premiumTooHigh ? <span className="text-brick-700">The premium must be less than the coverage.</span> : "Paid for each term."}>
        <Input type="number" min="0.01" step="0.01" required value={premium} onChange={(e) => setPremium(e.target.value)} />
      </Field>
      <Field label="Term (months)" hint="From 1 to 600 months. The policy starts today.">
        <Input type="number" min="1" max="600" step="1" required value={term} onChange={(e) => setTerm(e.target.value)} />
      </Field>
      <div className="flex items-end">
        <Button type="submit" busy={busy} disabled={premiumTooHigh} icon={<FilePlus2 className="size-4" />} className="w-full sm:w-auto">
          Create policy
        </Button>
      </div>
      {error && <div className="sm:col-span-2"><Notice>{error}</Notice></div>}
    </form>
  );
}

// -- tables ------------------------------------------------------------------

export function PolicyTable({ policies, empty }: { policies: Policy[]; empty: ReactNode }) {
  return (
    <Table
      rows={policies}
      rowKey={(p) => p.policy_no}
      empty={empty}
      columns={[
        { key: "no", header: "Policy", render: (p) => <Mono>{p.policy_no}</Mono> },
        {
          key: "type",
          header: "Type",
          render: (p) => (
            <span className="flex items-center gap-1.5 text-pine-800">
              {typeIcon(p.policy_type)}
              <span className="text-[13px] font-medium">{p.policy_type.charAt(0) + p.policy_type.slice(1).toLowerCase()}</span>
            </span>
          ),
        },
        { key: "customer", header: "Customer", render: (p) => `@${p.customer}` },
        { key: "agent", header: "Agent", render: (p) => `@${p.agent}` },
        { key: "coverage", header: "Coverage", align: "right", render: (p) => money(p.coverage) },
        { key: "premium", header: "Premium", align: "right", render: (p) => money(p.premium) },
        { key: "term", header: "Term", render: (p) => <span className="text-[13px] text-ink-soft">{date(p.start_date)} – {date(p.end_date)}</span> },
        { key: "status", header: "Status", render: (p) => <StatusBadge status={p.status} /> },
      ]}
    />
  );
}

export function PaymentTable({ payments, empty }: { payments: Payment[]; empty: ReactNode }) {
  const rows = [...payments].reverse();
  return (
    <Table
      rows={rows}
      rowKey={(p) => p.reference}
      empty={empty}
      columns={[
        { key: "ref", header: "Reference", render: (p) => <Mono>{p.reference}</Mono> },
        { key: "policy", header: "Policy", render: (p) => <Mono className="text-ink-soft">{p.policy_no}</Mono> },
        { key: "by", header: "Paid by", render: (p) => `@${p.paid_by}` },
        { key: "at", header: "Date", render: (p) => <span className="text-[13px] text-ink-soft">{date(p.paid_at)}</span> },
        { key: "amount", header: "Amount", align: "right", render: (p) => <span className="font-medium">{money(p.amount)}</span> },
      ]}
    />
  );
}

export const cardGrid = cx("grid gap-5 sm:grid-cols-2 xl:grid-cols-3");
