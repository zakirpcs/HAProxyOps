import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const s = status.toUpperCase();
  const color = s.startsWith("UP") || s === "OPEN"
    ? "var(--color-up)"
    : s.startsWith("DRAIN") || s.includes("MAINT") || s === "NOLB"
      ? "var(--color-drain)"
      : s.startsWith("DOWN") || s === "STOP"
        ? "var(--color-down)"
        : "var(--color-mute)";
  return (
    <span
      title={status}
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: color, boxShadow: `0 0 ${size}px ${color}55` }}
    />
  );
}

export function Panel({ title, actions, children }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900">
      {(title || actions) && (
        // Wraps rather than overflows: several panels carry a row of controls
        // that will not fit beside the title on a phone.
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-ink-700 px-3 py-2.5 sm:px-4">
          <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = "default" }: {
  label: string; value: ReactNode; tone?: "default" | "good" | "bad" | "warn";
}) {
  const color = { default: "text-slate-100", good: "text-[var(--color-up)]",
                  bad: "text-[var(--color-down)]", warn: "text-[var(--color-drain)]" }[tone];
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-mute)]">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

/**
 * Icon-only action button.
 *
 * `label` is required, not optional: an icon carries no accessible name of its
 * own, so it supplies both the aria-label and the hover tooltip. Without it the
 * control is invisible to a screen reader and a guess to everyone else.
 */
export function IconButton({ icon, label, onClick, variant = "default", disabled }: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "warn" | "good";
}) {
  const hover = {
    default: "hover:border-ink-600 hover:bg-ink-700 hover:text-slate-100",
    good: "hover:border-[var(--color-up)]/50 hover:bg-[var(--color-up)]/10 hover:text-[var(--color-up)]",
    warn: "hover:border-[var(--color-drain)]/50 hover:bg-[var(--color-drain)]/10 hover:text-[var(--color-drain)]",
    danger: "hover:border-[var(--color-down)]/50 hover:bg-[var(--color-down)]/10 hover:text-[var(--color-down)]",
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-[var(--color-mute)] transition focus-visible:border-[var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[var(--color-mute)] ${hover}`}
    >
      <Icon name={icon} />
    </button>
  );
}

export function humanBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function humanDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * The small "Frontend" / "Backend" caption that names each half of a service.
 *
 * Both halves are tables of similar-looking numbers, so without a caption the
 * only thing telling them apart is position.
 */
export function RoleLabel({ children, block = false }: { children: ReactNode; block?: boolean }) {
  return (
    <span className={`text-[10px] uppercase tracking-wider text-[var(--color-mute)]${
      block ? " mb-1 block" : ""
    }`}>
      {children}
    </span>
  );
}
