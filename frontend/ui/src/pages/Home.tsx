import { ArrowRight, Briefcase, Building2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Brand } from "../components/Shell";
import { cx } from "../components/ui";
import { api } from "../lib/api";
import { Link } from "../lib/router";

const roles = [
  {
    to: "/customer",
    title: "Customer",
    icon: UserRound,
    text: "See your policies, pay premiums, file a claim, and send the claim documents straight to your agent.",
  },
  {
    to: "/agent",
    title: "Agent",
    icon: Briefcase,
    text: "Create policies for your customers, record their payments, and receive and verify claim documents.",
  },
  {
    to: "/admin",
    title: "Administrator",
    icon: Building2,
    text: "Make accounts, approve or reject claims one time each, and read the summary report.",
  },
];

export function Home() {
  const [bridge, setBridge] = useState<{ up: boolean; server?: string } | null>(null);

  useEffect(() => {
    document.title = "E-Surance";
    api
      .health()
      .then((health) => setBridge({ up: true, server: health.server }))
      .catch(() => setBridge({ up: false }));
  }, []);

  return (
    <div className="grain min-h-screen">
      <header className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-8">
        <Brand tone="dark" />
        <span
          className={cx(
            "inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-[12.5px]",
            bridge?.up === false ? "border-brick-100 text-brick-700" : "border-line text-ink-soft",
          )}
        >
          <span className={cx("size-1.5 rounded-full", bridge === null ? "bg-line-strong" : bridge.up ? "bg-moss-700" : "bg-brick-700")} />
          {bridge === null ? "Looking for the bridge…" : bridge.up ? `Bridge ready · server ${bridge.server}` : "Bridge not running: start python bridge.py"}
        </span>
      </header>

      <main className="mx-auto max-w-[1180px] px-4 pb-16 sm:px-8">
        <section className="grid items-center gap-10 py-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:py-14">
          <div>
            <p className="eyebrow text-pine-700">Electronic insurance management</p>
            <h1 className="mt-3 font-display text-[40px] leading-[1.05] font-medium tracking-[-0.02em] text-ink sm:text-[54px]">
              Records on one server.
              <br />
              <span className="text-pine-700 italic">Claim documents</span> straight to your agent.
            </h1>
            <p className="mt-5 max-w-xl text-[16.5px] text-ink-soft">
              Policies, payments and claims are kept in one database, and the server checks every request. Medical reports and photos
              of the damage go directly from your computer to your agent's. The server keeps only their checksum.
            </p>
          </div>
          <NetworkPicture />
        </section>

        <section className="grid gap-5 md:grid-cols-3">
          {roles.map(({ to, title, icon: Icon, text }) => (
            <Link
              key={to}
              to={to}
              className="card group flex flex-col p-6 transition hover:-translate-y-0.5 hover:border-pine-200 hover:shadow-[0_18px_40px_-24px_rgba(10,35,33,0.45)]"
            >
              <span className="grid size-11 place-items-center rounded-xl bg-pine-100 text-pine-800">
                <Icon className="size-5" />
              </span>
              <h2 className="mt-4 font-display text-[23px] font-medium">{title}</h2>
              <p className="mt-1.5 flex-1 text-[14.5px] text-ink-soft">{text}</p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-pine-700">
                Open the {title.toLowerCase()} portal
                <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </section>

        <footer className="mt-14 flex flex-wrap justify-between gap-2 border-t border-line pt-5 text-[13px] text-ink-faint">
          <span>E-Surance · Client-Server and Peer-to-Peer Activity</span>
          <span>West Visayas State University, La Paz, Iloilo City</span>
        </footer>
      </main>
    </div>
  );
}

/** The hybrid design at a glance: solid links to the server, dashed links between peers. */
function NetworkPicture() {
  const peers = [
    { x: 70, label: "Customer" },
    { x: 210, label: "Agent" },
    { x: 350, label: "Admin" },
  ];
  return (
    <figure className="card p-5">
      <svg viewBox="0 0 420 270" role="img" aria-label="Three client programs linked to one server, and to each other directly" className="w-full">
        <rect x="120" y="14" width="180" height="70" rx="10" fill="var(--color-pine-950)" />
        <text x="210" y="44" textAnchor="middle" fill="var(--color-paper)" fontFamily="var(--font-display)" fontSize="17">
          E-Surance server
        </text>
        <text x="210" y="64" textAnchor="middle" fill="var(--color-pine-200)" fontFamily="var(--font-mono)" fontSize="11">
          records · port 5000
        </text>
        {peers.map((p) => (
          <line key={p.label} x1={p.x} y1="176" x2={p.x < 210 ? 165 : p.x > 210 ? 255 : 210} y2="84" stroke="var(--color-line-strong)" strokeWidth="1.5" />
        ))}
        <path d="M100 206 H180 M240 206 H320 M70 236 V250 H350 V236" fill="none" stroke="var(--color-pine-600)" strokeWidth="2" strokeDasharray="6 5" />
        {peers.map((p) => (
          <g key={p.label}>
            <rect x={p.x - 52} y="176" width="104" height="60" rx="9" fill="#fff" stroke="var(--color-line-strong)" />
            <text x={p.x} y="202" textAnchor="middle" fill="var(--color-ink)" fontSize="13.5" fontWeight="600" fontFamily="var(--font-sans)">
              {p.label}
            </text>
            <text x={p.x} y="221" textAnchor="middle" fill="var(--color-ink-faint)" fontSize="10.5" fontFamily="var(--font-mono)">
              peer node
            </text>
          </g>
        ))}
        <text x="203" y="134" textAnchor="end" fill="var(--color-ink-faint)" fontSize="11" fontFamily="var(--font-sans)">request · reply</text>
        <text x="210" y="266" textAnchor="middle" fill="var(--color-pine-700)" fontSize="11" fontFamily="var(--font-sans)">
          messages and documents, peer to peer
        </text>
      </svg>
    </figure>
  );
}
