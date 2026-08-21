import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Panel, StatusDot, humanDuration } from "../components/ui";
import type { CurrentAlert } from "../types";

/**
 * What is wrong right now.
 *
 * Evaluated from the same rules the notifier uses, so this is not a second
 * opinion that can disagree with the alerts people receive — it is the same
 * assessment, shown rather than sent.
 */
export default function Alerts() {
  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    // The poller re-evaluates on its own cadence; this just needs to keep up.
    refetchInterval: 15_000,
  });

  const alerts = query.data?.alerts ?? [];
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const pending = alerts.filter((a) => a.state === "pending").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Alerts</h1>
        <span className="text-xs text-[var(--color-mute)]">
          {query.isLoading ? "loading…"
            : alerts.length === 0 ? "nothing firing"
              : `${alerts.length} active${critical ? ` · ${critical} critical` : ""}`}
        </span>
      </div>

      {query.data && !query.data.delivery_configured && (
        // The page is useful without a webhook, but silence is not the same as
        // health and the difference has to be obvious.
        <p className="rounded border border-[var(--color-drain)]/40 bg-[var(--color-drain)]/10 px-3 py-2 text-sm text-[var(--color-drain)]">
          No webhook configured, so nothing is being sent anywhere. This page shows
          what alerting <em>would</em> deliver — set{" "}
          <code className="text-slate-300">HAPROXYOPS_ALERT_WEBHOOK_URL</code> to turn
          delivery on.
        </p>
      )}

      {query.isError && (
        <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-sm text-[var(--color-down)]">
          {(query.error as Error).message}
        </p>
      )}

      <Panel title={`Active (${alerts.length})`}>
        {alerts.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">
            {query.isLoading
              ? "Loading…"
              : "Nothing is firing. Every node is reachable and every backend has active servers up."}
          </p>
        ) : (
          <div className="space-y-2">
            {alerts.map((alert) => <AlertRow key={alert.key} alert={alert} />)}
          </div>
        )}

        {pending > 0 && query.data && (
          <p className="mt-3 text-xs text-[var(--color-mute)]">
            {pending} {pending === 1 ? "alert has" : "alerts have"} not been sent yet:
            a problem must last {Math.round(query.data.for_seconds)}s before it is
            announced, so a node restarting is not an incident.
          </p>
        )}
      </Panel>
    </div>
  );
}

function AlertRow({ alert }: { alert: CurrentAlert }) {
  const critical = alert.severity === "critical";
  const nodeId = alert.labels.node_id;

  return (
    <div className={`rounded border px-3 py-2 ${
      critical
        ? "border-[var(--color-down)]/50 bg-[var(--color-down)]/10"
        : "border-[var(--color-drain)]/40 bg-[var(--color-drain)]/5"
    }`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot status={critical ? "DOWN" : "DRAIN"} size={7} />
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${
          critical ? "text-[var(--color-down)]" : "text-[var(--color-drain)]"
        }`}>
          {alert.severity}
        </span>
        <span className="text-sm font-medium text-slate-100">{alert.title}</span>

        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-mute)]">
          <span title={new Date(alert.since * 1000).toLocaleString()}>
            for {humanDuration(Math.round(alert.for_seconds))}
          </span>
          {alert.state === "pending" ? (
            <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                  title="Live, but not yet long enough to have been announced">
              pending
            </span>
          ) : (
            <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300"
                  title="This has been sent to the webhook">
              sent
            </span>
          )}
        </span>
      </div>

      <p className="mt-1 text-xs text-[var(--color-mute)]">{alert.detail}</p>

      {nodeId != null && (
        <Link to={`/nodes/${nodeId}`}
              className="mt-1 inline-block text-[11px] text-[var(--color-accent)] hover:underline">
          Open {alert.node} →
        </Link>
      )}
    </div>
  );
}
