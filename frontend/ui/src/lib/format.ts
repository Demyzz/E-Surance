const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const pesoWhole = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat("en-PH", { day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-PH", { hour: "numeric", minute: "2-digit" });

export const money = (value: number) => peso.format(value);
export const moneyShort = (value: number) => pesoWhole.format(value);

// The server sends ISO text: "2026-11-17" or "2026-11-17T07:55:38".
function parse(value: string) {
  return new Date(value.length === 10 ? `${value}T00:00:00` : value);
}

export const date = (value: string | null | undefined) => (value ? dateFormat.format(parse(value)) : "");

export const dateTime = (value: string | null | undefined) =>
  value ? `${dateFormat.format(parse(value))}, ${timeFormat.format(parse(value))}` : "";

export const time = (value: string) => timeFormat.format(parse(value));

export function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

/** How far a policy term has run, from 0 to 1. */
export function termProgress(start: string, end: string, now = new Date()) {
  const from = parse(start).getTime();
  const to = parse(end).getTime();
  if (to <= from) return 1;
  return Math.min(1, Math.max(0, (now.getTime() - from) / (to - from)));
}

export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export const firstName = (fullName: string) => fullName.split(" ")[0] || fullName;

/** plural(1, "claim") -> "1 claim"; plural(2, "claim") -> "2 claims" */
export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
