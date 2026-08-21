import type {
  AppUser, AuditEntry, FleetSummary, ManagedNode, NodeSnapshot, Role, SearchHit,
} from "./types";

const TOKEN_KEY = "haproxyops.token";

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);

  const response = await fetch(`/api${path}`, { ...init, headers });
  if (response.status === 401) {
    auth.clear();
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (!response.ok) {
    // FastAPI puts the human-readable reason in `detail`.
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.detail ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; username: string; role: Role }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<{ username: string; role: Role }>("/auth/me"),

  fleet: () => request<{ nodes: NodeSnapshot[]; summary: FleetSummary }>("/fleet"),
  nodeState: (id: number) => request<NodeSnapshot>(`/nodes/${id}/state`),
  nodeConfig: (id: number) => request<Record<string, unknown>>(`/nodes/${id}/config`),

  listNodes: () => request<ManagedNode[]>("/nodes"),
  createNode: (body: Record<string, unknown>) =>
    request<ManagedNode>("/nodes", { method: "POST", body: JSON.stringify(body) }),
  updateNode: (id: number, body: Record<string, unknown>) =>
    request<ManagedNode>(`/nodes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteNode: (id: number) => request<void>(`/nodes/${id}`, { method: "DELETE" }),
  testNode: (id: number) =>
    request<{ reachable: boolean; error: string | null; version: string | null;
              duration_ms: number; capabilities: string[] }>(`/nodes/${id}/test`, {
      method: "POST",
    }),

  setAdminState: (nodeId: number, backend: string, server: string, state: string) =>
    request<unknown>(
      `/nodes/${nodeId}/backends/${encodeURIComponent(backend)}/servers/${encodeURIComponent(server)}/admin-state`,
      { method: "PUT", body: JSON.stringify({ state }) },
    ),
  // The API still exposes /weight, but the Data Plane API has no runtime weight
  // field so it always answers 501. Wire this up when config editing lands.
  setWeight: (nodeId: number, backend: string, server: string, weight: number) =>
    request<unknown>(
      `/nodes/${nodeId}/backends/${encodeURIComponent(backend)}/servers/${encodeURIComponent(server)}/weight`,
      { method: "PUT", body: JSON.stringify({ weight }) },
    ),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  audit: (limit = 200) => request<AuditEntry[]>(`/audit?limit=${limit}`),

  listUsers: () => request<AppUser[]>("/auth/users"),
  createUser: (body: { username: string; password: string; role: Role }) =>
    request<AppUser>("/auth/users", { method: "POST", body: JSON.stringify(body) }),
  revokeSessions: (username: string) =>
    request<void>(`/auth/users/${encodeURIComponent(username)}/revoke`, { method: "POST" }),
  metricsStatus: () => request<{ enabled: boolean }>("/metrics/status"),
  nodeMetrics: (nodeId: number, minutes: number) =>
    request<{ node_id: number; minutes: number; panels: Array<{
      key: string; title: string; unit: string; description: string;
      series: Array<{ name: string; points: [number, number | null][] }>;
    }> }>(`/nodes/${nodeId}/metrics?minutes=${minutes}`),

  search: (q: string) =>
    request<{ query: string; count: number; results: SearchHit[] }>(
      `/search?q=${encodeURIComponent(q)}`,
    ),
};

/** Open the live snapshot stream. Token goes in the query string because
 *  EventSource cannot send an Authorization header. */
export function openSnapshotStream(onSnapshot: (s: NodeSnapshot) => void): EventSource {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(auth.token ?? "")}`);
  source.addEventListener("snapshot", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent).data));
    } catch {
      /* ignore malformed frame */
    }
  });
  return source;
}
