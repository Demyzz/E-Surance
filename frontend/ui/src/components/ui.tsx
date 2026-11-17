import { Check, CircleAlert, Copy, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import { shortHash } from "../lib/format";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

// -- buttons -----------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger" | "approve";

const variants: Record<Variant, string> = {
  primary: "bg-pine-800 text-white hover:bg-pine-900 shadow-[inset_0_-1px_0_rgba(0,0,0,0.2)]",
  secondary: "bg-white text-ink border border-line-strong hover:bg-paper",
  ghost: "text-ink-soft hover:bg-paper-deep hover:text-ink",
  danger: "bg-white text-brick-700 border border-brick-100 hover:bg-brick-100",
  approve: "bg-moss-700 text-white hover:bg-[#275a25]",
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  busy,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition select-none",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-pine-200",
        "disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-[14.5px]",
        variants[variant],
        className,
      )}
      {...props}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// -- form fields -------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12.5px] text-ink-faint">{hint}</span>}
    </label>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={cx("field", props.className)} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={cx("field appearance-none bg-no-repeat pr-9", props.className)}
    style={{
      backgroundImage:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%234b5961' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
      backgroundPosition: "right 0.8rem center",
    }}
  />
);

export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={cx("field min-h-20 resize-y", props.className)} />
);

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-line bg-paper p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition",
            value === option.value ? "bg-white text-pine-800 shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// -- surfaces ----------------------------------------------------------------

export function Card({
  title,
  eyebrow,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {eyebrow && <p className="eyebrow mb-0.5">{eyebrow}</p>}
            {title && <h2 className="text-[15.5px] font-semibold text-ink">{title}</h2>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-display text-[30px] leading-tight font-medium tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1.5 text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatTile({ label, value, detail, accent }: { label: string; value: ReactNode; detail?: ReactNode; accent?: string }) {
  return (
    <div className="card relative min-w-0 overflow-hidden px-4 py-4 sm:px-5">
      <span className={cx("absolute inset-y-0 left-0 w-1", accent ?? "bg-pine-700")} />
      <p className="eyebrow">{label}</p>
      <p className="num mt-1.5 font-display text-[23px] leading-none font-medium break-words text-ink sm:text-[28px]">{value}</p>
      {detail && <p className="mt-2 text-[13px] text-ink-soft">{detail}</p>}
    </div>
  );
}

// -- status ------------------------------------------------------------------

type Tone = "neutral" | "pine" | "marigold" | "moss" | "brick";

const tones: Record<Tone, string> = {
  neutral: "bg-paper-deep text-ink-soft",
  pine: "bg-pine-100 text-pine-800",
  marigold: "bg-marigold-100 text-marigold-700",
  moss: "bg-moss-100 text-moss-700",
  brick: "bg-brick-100 text-brick-700",
};

export function Badge({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap", tones[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  ACTIVE: "moss",
  PENDING: "marigold",
  APPROVED: "moss",
  REJECTED: "brick",
  LAPSED: "neutral",
  CANCELLED: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone[status] ?? "neutral"} dot>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}

export function Notice({ tone = "error", children }: { tone?: "error" | "info" | "warning" | "success"; children: ReactNode }) {
  const styles = {
    error: ["bg-brick-100/70 text-brick-700 border-brick-100", CircleAlert],
    warning: ["bg-marigold-100/70 text-marigold-700 border-marigold-100", TriangleAlert],
    info: ["bg-pine-50 text-pine-800 border-pine-100", Info],
    success: ["bg-moss-100/70 text-moss-700 border-moss-100", Check],
  } as const;
  const [className, Icon] = styles[tone];
  return (
    <div className={cx("flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13.5px]", className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-paper text-ink-faint ring-1 ring-line">{icon}</div>
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13.5px] text-ink-soft">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-8 text-[13.5px] text-ink-faint">
      <LoaderCircle className="size-4 animate-spin" /> {label}…
    </div>
  );
}

// -- data --------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: "right";
  className?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onSelect,
  selected,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onSelect?: (row: T) => void;
  selected?: string | null;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="-mx-5 -my-5 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[14px]">
        <thead>
          <tr className="border-b border-line bg-paper/60">
            {columns.map((column) => (
              <th
                key={column.key}
                className={cx("px-5 py-2.5 text-[11px] font-semibold tracking-[0.12em] whitespace-nowrap text-ink-faint uppercase", column.align === "right" && "text-right")}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                onClick={onSelect ? () => onSelect(row) : undefined}
                className={cx(
                  "border-b border-line last:border-b-0",
                  onSelect && "cursor-pointer hover:bg-pine-50/60",
                  selected === key && "bg-pine-50",
                )}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cx("px-5 py-3 align-middle whitespace-nowrap", column.align === "right" && "num text-right", column.className)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[13px] tracking-tight", className)}>{children}</span>;
}

export function Hash({ value, full }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <Mono className={cx("text-ink-soft", full && "break-all")}>{full ? value : shortHash(value)}</Mono>
      <button
        type="button"
        title="Copy the SHA-256 checksum"
        onClick={(event) => {
          event.stopPropagation();
          navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
        className="rounded p-0.5 text-ink-faint hover:bg-paper-deep hover:text-ink"
      >
        {copied ? <Check className="size-3.5 text-moss-700" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
