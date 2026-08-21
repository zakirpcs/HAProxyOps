import { vi } from "vitest";
import type { NodeSnapshot } from "../types";

/**
 * A controllable EventSource, installed on globalThis.
 *
 * jsdom does not implement EventSource, so without this any component opening
 * a stream throws. That is deliberate: a test only sees a connection if it
 * asked for one, and `instances` is what makes "one stream per tab" an
 * assertion rather than a claim in a README.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  /** Instances that have not been closed - i.e. connections actually held. */
  static get open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((i) => !i.closed);
  }
  static reset(): void {
    FakeEventSource.instances = [];
  }

  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }

  close(): void {
    this.closed = true;
  }

  /** Drive the stream from a test. */
  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  connect(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

export function installEventSource(): typeof FakeEventSource {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
  return FakeEventSource;
}

/** Minimal snapshot; override only what a test cares about. */
export function snapshot(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    node_id: 1,
    node_name: "lb-edge-1",
    group: "edge",
    reachable: true,
    error: null,
    polled_at: new Date().toISOString(),
    duration_ms: 12,
    info: { version: "3.0", uptime_seconds: 100, process_id: 1, node_name: "lb", release_date: null },
    frontends: [],
    backends: [],
    capabilities: ["read_state", "read_config", "set_admin_state"],
    ...over,
  } as NodeSnapshot;
}

/** Stub `fetch` for the handful of endpoints the shell touches on boot. */
export function installFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const path = String(url).replace(/^\/api/, "").split("?")[0];
    if (!(path in routes)) {
      return { ok: false, status: 404, json: async () => ({ detail: `no stub for ${path}` }) };
    }
    return { ok: true, status: 200, json: async () => routes[path] };
  });
  vi.stubGlobal("fetch", fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}
