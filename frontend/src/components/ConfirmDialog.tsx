import type { ReactNode } from "react";
import Modal from "./Modal";

interface Props {
  open: boolean;
  title: string;
  /** What is about to happen, and just as importantly what is not. */
  children: ReactNode;
  confirmLabel: string;
  variant?: "danger" | "warn" | "default";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

const CONFIRM_STYLES = {
  danger: "bg-[var(--color-down)] text-white",
  warn: "bg-[var(--color-drain)] text-black",
  default: "bg-[var(--color-accent)] text-white",
} as const;

/**
 * Confirmation dialog for an action that cannot simply be undone.
 *
 * Cancel is deliberately first in the DOM and carries autoFocus, so the native
 * dialog's initial focus lands on the safe option and a stray Enter dismisses
 * rather than confirms.
 */
export default function ConfirmDialog({
  open, title, children, confirmLabel, variant = "danger",
  busy = false, error = null, onConfirm, onClose,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      width="30rem"
      footer={
        <>
          <button
            type="button" onClick={onClose} disabled={busy} autoFocus
            className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-ink-700 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button" onClick={onConfirm} disabled={busy}
            className={`rounded px-3 py-1.5 text-sm font-medium transition hover:brightness-110 disabled:opacity-50 ${CONFIRM_STYLES[variant]}`}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-300">
        {children}
        {error && (
          <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-xs text-[var(--color-down)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
