import { ArrowLeft, LogIn, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Brand, roleLabel } from "../components/Shell";
import { Button, Field, Input, Notice, Segmented } from "../components/ui";
import { api, type Role } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { useSession } from "../lib/session";

const about: Record<Role, { headline: string; points: string[]; demo?: [string, string] }> = {
  customer: {
    headline: "Your policies, payments and claims in one place.",
    points: [
      "See each policy with its coverage and term",
      "Pay a premium and get a payment reference",
      "File a claim, then send the documents straight to your agent",
    ],
  },
  agent: {
    headline: "Serve your customers, and receive their claim documents.",
    points: [
      "Create life, health, motor and property policies",
      "Record premium payments for your customers",
      "Check each received document against its recorded checksum",
    ],
    demo: ["agent", "agent123"],
  },
  admin: {
    headline: "Accounts, claim decisions and the full report.",
    points: ["Make customer, agent and administrator accounts", "Approve or reject each claim, one time only", "See the totals for all records"],
    demo: ["admin", "admin123"],
  },
};

export function Login({ role }: { role: Role }) {
  const { login } = useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const page = about[role];

  useEffect(() => {
    document.title = `E-Surance · ${roleLabel[role]} log in`;
  }, [role]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "register") {
        await api.register(username, password, fullName);
        setMode("login");
        setInfo(`Account @${username} is ready. Log in with your new password.`);
        setPassword("");
      } else {
        const session = await login(username, password);
        if (session.user.role !== role) navigate(`/${session.user.role}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <aside className="relative flex flex-col justify-between overflow-hidden bg-pine-950 px-6 py-8 text-paper sm:px-12 lg:py-12">
        <svg aria-hidden viewBox="0 0 400 400" className="pointer-events-none absolute -right-24 -bottom-24 w-[420px] text-pine-900">
          <circle cx="200" cy="200" r="190" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="200" cy="200" r="140" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="5 7" />
          <circle cx="200" cy="200" r="90" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <Link to="/" className="relative inline-flex w-fit items-center gap-2 text-[13px] text-pine-200/80 hover:text-white">
          <ArrowLeft className="size-4" /> All portals
        </Link>
        <div className="relative my-12 max-w-md">
          <Brand />
          <p className="mt-8 text-[12px] font-medium tracking-[0.16em] text-pine-200/70 uppercase">{roleLabel[role]} portal</p>
          <h1 className="mt-2 font-display text-[34px] leading-[1.1] font-medium">{page.headline}</h1>
          <ul className="mt-6 space-y-2.5 text-[14.5px] text-pine-100/80">
            {page.points.map((point) => (
              <li key={point} className="flex gap-3">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-marigold-500" />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-[12.5px] text-pine-200/60">
          Your browser talks to the bridge on this computer. The bridge keeps your connection to the server and your peer node.
        </p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <form onSubmit={submit} className="w-full max-w-[400px]">
          <h2 className="font-display text-[28px] font-medium">{mode === "login" ? "Log in" : "Create a customer account"}</h2>
          <p className="mt-1 text-[14px] text-ink-soft">
            {mode === "login" ? `Use your ${roleLabel[role].toLowerCase()} account.` : "New accounts are customer accounts. An administrator makes the others."}
          </p>

          {role === "customer" && (
            <div className="mt-5">
              <Segmented
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  setError(null);
                  setInfo(null);
                }}
                options={[
                  { value: "login", label: <><LogIn className="size-4" />Log in</> },
                  { value: "register", label: <><UserPlus className="size-4" />Register</> },
                ]}
              />
            </div>
          )}

          <div className="mt-6 space-y-4">
            {mode === "register" && (
              <Field label="Full name">
                <Input required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Juan Dela Cruz" />
              </Field>
            )}
            <Field label="Username" hint={mode === "register" ? "3 to 20 letters, digits, or _" : undefined}>
              <Input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Password" hint={mode === "register" ? "6 characters or more" : undefined}>
              <Input
                required
                type="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <Notice>{error}</Notice>}
            {info && <Notice tone="success">{info}</Notice>}
            <Button type="submit" busy={busy} className="w-full" icon={mode === "login" ? <LogIn className="size-4" /> : <UserPlus className="size-4" />}>
              {mode === "login" ? "Log in" : "Create account"}
            </Button>
          </div>

          {page.demo && (
            <p className="mt-6 rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-soft">
              Demo account: <span className="font-mono text-ink">{page.demo[0]}</span> /{" "}
              <span className="font-mono text-ink">{page.demo[1]}</span>. Change it before a real use.
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
