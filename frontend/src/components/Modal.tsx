import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** While true the dialog refuses to dismiss, so a submit is never orphaned. */
  busy?: boolean;
  width?: string;
}

/**
 * Modal built on the native <dialog> element.
 *
 * showModal() gives focus trapping, Escape handling, the top layer and an inert
 * background for free - all of which are easy to get subtly wrong by hand, and
 * all of which matter for a form that can destroy or create infrastructure.
 */
export default function Modal({
  open, onClose, title, description, children, footer, busy = false, width = "40rem",
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // The native "cancel" event fires on Escape. Intercept it so a submit in
  // flight cannot be dismissed out from under itself.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (!busy) onClose();
    };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [busy, onClose]);

  // A modal dialog blocks interaction but not scrolling; pin the page so the
  // background does not drift behind the overlay.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      // Clicks on the backdrop land on the dialog element itself; clicks inside
      // land on its children, so this distinguishes the two without a wrapper.
      onClick={(event) => {
        if (event.target === ref.current && !busy) onClose();
      }}
      className="m-auto w-[calc(100vw-2rem)] max-w-[var(--modal-width)] rounded-xl border border-ink-700 bg-ink-900 p-0 text-slate-200 shadow-2xl backdrop:bg-black/70"
      style={{ "--modal-width": width } as React.CSSProperties}
    >
      <div className="flex max-h-[85vh] flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-3.5">
          <div>
            <h2 id="modal-title" className="text-sm font-semibold text-slate-100">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs text-[var(--color-mute)]">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-1 -mt-0.5 rounded px-2 py-0.5 text-lg leading-none text-[var(--color-mute)] transition hover:bg-ink-800 hover:text-slate-200 disabled:opacity-40"
          >
            &times;
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-ink-700 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}
