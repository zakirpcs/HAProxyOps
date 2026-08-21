import type { ReactNode } from "react";

/**
 * Inline stroke icons. No icon dependency: the set is small and fixed, and a
 * font or sprite would be another asset to ship and cache-bust.
 *
 * Paths are drawn on a 24x24 grid and inherit currentColor, so a button's
 * hover and disabled colours carry through without extra wiring.
 */
const PATHS: Record<string, ReactNode> = {
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
  test: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  play: <path d="M6 4l14 8-14 8Z" />,
  pause: <><path d="M7 4h3v16H7z" /><path d="M14 4h3v16h-3z" /></>,
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M9 6V4h6v2" />
      <path d="M6 6l1 14h10l1-14" />
    </>
  ),
  // Brand mark: one ingress fanning out to three servers, which is the whole
  // job of a load balancer and reads at 18px.
  logo: (
    <>
      <circle cx="4" cy="12" r="1.9" />
      <circle cx="19" cy="5" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
      <circle cx="19" cy="19" r="1.9" />
      <path d="M5.9 12h3.4" />
      <path d="M9.3 12 17.2 5.6" />
      <path d="M9.3 12h7.8" />
      <path d="M9.3 12 17.2 18.4" />
    </>
  ),
  logout: (
    <>
      <path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </>
  ),
  // Drain: traffic flowing down and out to a floor line.
  drain: <><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><path d="M5 20h14" /></>,
  // Maint: a wrench reads as "out for maintenance" more directly than any
  // abstract stop/block glyph.
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
  ),
};

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
