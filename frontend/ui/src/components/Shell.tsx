import { LogOut, Radio, Server, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Role } from "../lib/api";
import { Link } from "../lib/router";
import { useSession } from "../lib/session";
import { cx } from "./ui";

export const roleLabel: Record<Role, string> = {
  customer: "Customer",
  agent: "Agent",
  admin: "Administrator",
};

export function BrandMark({ className }: { className?: string }) {
  // A shield, with an E drawn from three ruled lines: a policy document.
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <path d="M16 2.5 4.5 6.8v8.4c0 7.3 4.9 12.4 11.5 14.3 6.6-1.9 11.5-7 11.5-14.3V6.8Z" fill="currentColor" />
      <path
        d="M11 10.5h10M11 16h8M11 21.5h10M11 10.5v11"
        stroke="var(--color-pine-950)"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function Brand({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark className={cx("size-8", tone === "light" ? "text-pine-200" : "text-pine-800")} />
      <span className={cx("font-display text-[21px] font-semibold tracking-[-0.01em]", tone === "light" ? "text-paper" : "text-ink")}>
        E-Surance
      </span>
    </span>
  );
}

export interface Section {
  key: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

export function Shell({
  role,
  sections,
  active,
  children,
}: {
  role: Role;
  sections: Section[];
  active: string;
  children: ReactNode;
}) {
  const { session, server, logout } = useSession();
  const user = session!.user;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[252px_minmax(0,1fr)] lg:bg-[linear-gradient(to_right,var(--color-pine-950)_252px,transparent_252px)]">
      <aside className="flex flex-col bg-pine-950 text-paper lg:sticky lg:top-0 lg:h-screen">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 lg:block">
          <Link to="/" className="inline-block rounded-md focus-visible:ring-2 focus-visible:ring-pine-200 focus-visible:outline-none">
            <Brand />
          </Link>
          <p className="mt-0 text-[12px] font-medium tracking-[0.16em] text-pine-200/70 uppercase lg:mt-3">
            {roleLabel[role]} portal
          </p>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-0">
          {sections.map((section) => (
            <Link
              key={section.key}
              to={`/${role}/${section.key}`}
              className={cx(
                "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition",
                active === section.key
                  ? "bg-pine-800 text-white shadow-[inset_0_0_0_1px_rgba(185,216,209,0.15)]"
                  : "text-pine-100/75 hover:bg-pine-900 hover:text-white",
              )}
            >
              <span className="[&>svg]:size-[18px]">{section.icon}</span>
              {section.label}
              {!!section.badge && (
                <span className="ml-auto rounded-full bg-marigold-500 px-1.5 text-[11px] leading-[18px] font-semibold text-pine-950">
                  {section.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div className="mt-auto hidden border-t border-white/10 p-4 lg:block">
          <p className="truncate text-[14px] font-medium text-white">{user.full_name}</p>
          <p className="truncate text-[12.5px] text-pine-100/60">
            @{user.username} · {roleLabel[user.role]}
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] text-pine-100/80 transition hover:bg-pine-900 hover:text-white"
          >
            <LogOut className="size-4" /> Log out
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="flex flex-wrap items-center justify-end gap-2 border-b border-line bg-paper/80 px-4 py-3 backdrop-blur sm:px-8">
          <ServerPill state={server} />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1 text-[12.5px] text-ink-soft">
            <Radio className="size-3.5 text-pine-700" />
            Peer node on port <span className="num font-mono text-ink">{session!.peer_port}</span>
          </span>
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1 text-[12.5px] text-ink-soft hover:text-ink lg:hidden"
          >
            <LogOut className="size-3.5" /> Log out
          </button>
        </header>
        {server === "offline" && (
          <div className="border-b border-marigold-100 bg-marigold-100/60 px-4 py-2.5 text-[13.5px] text-marigold-700 sm:px-8">
            <strong className="font-semibold">The server is not available.</strong> Records cannot load now, but messages and
            documents still go peer to peer. The next request connects and logs in again by itself.
          </div>
        )}
        <main className="mx-auto max-w-[1200px] px-4 py-7 sm:px-8 sm:py-9">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}

function ServerPill({ state }: { state: "online" | "offline" | "unknown" }) {
  const look = {
    online: ["border-moss-100 bg-moss-100/60 text-moss-700", "Server online"],
    offline: ["border-marigold-100 bg-marigold-100 text-marigold-700", "Server offline"],
    unknown: ["border-line bg-white text-ink-faint", "Checking server"],
  } as const;
  const [className, label] = look[state];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium", className)}>
      <Server className="size-3.5" />
      {label}
      <span className={cx("size-1.5 rounded-full bg-current", state === "online" && "animate-pulse")} />
    </span>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useSession();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cx(
            "pointer-events-auto flex items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-[0_12px_32px_-12px_rgba(10,35,33,0.35)]",
            toast.tone === "error" ? "border-brick-100" : toast.tone === "success" ? "border-moss-100" : "border-line",
          )}
        >
          <span
            className={cx(
              "mt-1.5 size-2 shrink-0 rounded-full",
              toast.tone === "error" ? "bg-brick-700" : toast.tone === "success" ? "bg-moss-700" : "bg-pine-600",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink">{toast.title}</p>
            {toast.body && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-soft">{toast.body}</p>}
          </div>
          <button type="button" onClick={() => dismiss(toast.id)} className="text-ink-faint hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
