import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

/**
 * jsdom has no ResizeObserver, and the charts size themselves from one.
 *
 * The stub reports a fixed, non-zero width once, so a chart renders at a
 * predictable size instead of collapsing to zero and drawing nothing. It does
 * not observe anything: nothing resizes in jsdom, and a test that depended on
 * a resize would be testing the stub.
 */
if (!("ResizeObserver" in globalThis)) {
  class StubResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.cb(
        [{ target, contentRect: { width: 800, height: 240 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

/**
 * jsdom implements <dialog> as an element but not its modal behaviour, so
 * showModal() is undefined and every component built on it throws.
 *
 * This shim gives back only the parts the app's logic depends on: the `open`
 * property, and the `close`/`cancel` events. It deliberately does not emulate
 * the top layer, focus trapping, or inertness of the background - those come
 * from the browser, and a test here cannot vouch for them. What it does let us
 * test is the surrounding flow: what opens a dialog, what closes it, what is
 * refused while a request is in flight, and what gets sent when it is confirmed.
 */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event("close"));
  };
}

// jsdom has no EventSource, which is convenient: every test that touches the
// fleet stream must install the stub from ./sse, and any component opening a
// connection it did not declare fails loudly instead of silently.
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});
