export type Role = "viewer" | "operator" | "admin";
export type AdminState = "ready" | "maint" | "drain";

export interface ServerStat {
  name: string;
  backend: string;
  status: string;
  address: string | null;
  weight: number | null;
  active: boolean;
  backup: boolean;
  sessions_current: number;
  sessions_max: number;
  sessions_total: number;
  queue_current: number;
  bytes_in: number;
  bytes_out: number;
  connection_errors: number;
  response_errors: number;
  check_status: string | null;
  check_failures: number;
  downtime_seconds: number;
  last_change_seconds: number;
  is_up: boolean;
}

export interface BackendStat {
  name: string;
  status: string;
  sessions_current: number;
  sessions_max: number;
  sessions_total: number;
  queue_current: number;
  bytes_in: number;
  bytes_out: number;
  connection_errors: number;
  response_errors: number;
  servers: ServerStat[];
  servers_up: number;
  servers_total: number;
}

export interface FrontendStat {
  name: string;
  status: string;
  sessions_current: number;
  sessions_max: number;
  sessions_limit: number;
  sessions_total: number;
  bytes_in: number;
  bytes_out: number;
  request_errors: number;
  requests_denied: number;
  rate: number;
  /** From `default_backend`. Null on transports that cannot read config. */
  default_backend: string | null;
  /** From `use_backend` rules, in config order. */
  rule_backends: string[];
  /** default_backend followed by rule targets, deduplicated. */
  routed_backends: string[];
  /** Lua actions this frontend runs; any of them may select a backend. */
  lua_actions: string[];
}

export interface NodeSnapshot {
  node_id: number;
  node_name: string;
  group: string;
  reachable: boolean;
  error: string | null;
  polled_at: string;
  duration_ms: number;
  info: {
    version: string | null;
    uptime_seconds: number | null;
    process_id: number | null;
    node_name: string | null;
  };
  frontends: FrontendStat[];
  backends: BackendStat[];
  capabilities: string[];
  enabled?: boolean;
  pending?: boolean;
}

export interface FleetSummary {
  nodes_total: number;
  nodes_up: number;
  nodes_down: number;
  frontends: number;
  backends: number;
  servers_total: number;
  /** Active servers that are down. Backups are excluded - see backups_down. */
  servers_down: number;
  /** Backup servers that are down: the fallback is gone, traffic is not. */
  backups_down: number;
  sessions_current: number;
}

export interface ManagedNode {
  id: number;
  name: string;
  group: string;
  driver: "dataplane" | "stats_csv";
  base_url: string;
  api_prefix: string;
  stats_path: string;
  username: string | null;
  prometheus_instance: string | null;
  verify_tls: boolean;
  enabled: boolean;
  has_password: boolean;
  created_at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  username: string;
  action: string;
  node_name: string | null;
  target: string | null;
  detail: string | null;
  success: boolean;
  source_ip: string | null;
}

export interface SearchHit {
  node_id: number;
  node_name: string;
  kind: "frontend" | "backend" | "server";
  name: string;
  /** Present for servers: the backend they belong to. */
  backend?: string;
  status: string;
}

export interface AppUser {
  id: number;
  username: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface CurrentAlert {
  key: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  node: string;
  labels: Record<string, string | number>;
  since: number;
  for_seconds: number;
  /** "pending" is live but not yet long enough to have been announced. */
  state: "firing" | "pending";
}

export interface AlertsResponse {
  delivery_configured: boolean;
  for_seconds: number;
  count: number;
  alerts: CurrentAlert[];
}

export interface AlertWebhookStatus {
  configured: boolean;
  /** "ui": set from this page. "env": HAPROXYOPS_ALERT_WEBHOOK_URL only. */
  source: "ui" | "env" | "none";
}
