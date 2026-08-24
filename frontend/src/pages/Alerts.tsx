import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Panel, StatusDot, humanDuration } from "../components/ui";
import type { CurrentAlert } from "../types";

const FIELD =
  "w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

/**
 * What is wrong right now.
 *
 * Evaluated from the same rules the notifier uses, so this is not a second
 * opinion that can disagree with the alerts people receive - it is the same
 * assessment, shown rather than sent.
 *
 * Laid out as one row per alert rather than a stack of cards: a fleet in real
 * trouble produces dozens at once, and a page you have to scroll to count is a
 * page that hides the scale of the problem.
 */
export default function Alerts() {
  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: api.alerts,
    // The poller re-evaluates on its own cadence; this just needs to keep up.
    refetchInterval: 15_000,
  });
  // Not for access control - the endpoint below is admin-gated server-side
  // regardless. This only decides whether to show the panel at all, the same
  // way the nav bar hides Audit/Users from non-admins.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const alerts = query.data?.alerts ?? [];
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const pending = alerts.filter((a) => a.state === "pending").length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
        <p className="rounded border border-[var(--color-drain)]/40 bg-[var(--color-drain)]/10 px-3 py-1.5 text-xs text-[var(--color-drain)]">
          No webhook configured, so nothing is being sent anywhere. This page shows
          what alerting <em>would</em> deliver — set one below (admins) or via{" "}
          <code className="text-slate-300">HAPROXYOPS_ALERT_WEBHOOK_URL</code>.
        </p>
      )}

      {me.data?.role === "admin" && <WebhookSettings />}

      {query.isError && (
        <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-1.5 text-xs text-[var(--color-down)]">
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
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--color-mute)]">
                <tr>
                  <th className="pb-1.5 pr-2">Sev</th>
                  <th className="pb-1.5 pr-2">Node</th>
                  <th className="pb-1.5 pr-2">Alert</th>
                  <th className="pb-1.5 pr-2 text-right">For</th>
                  <th className="pb-1.5 text-right">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {alerts.map((alert) => <AlertRow key={alert.key} alert={alert} />)}
              </tbody>
            </table>
          </div>
        )}

        {pending > 0 && query.data && (
          <p className="mt-2 text-[11px] text-[var(--color-mute)]">
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
  // The node is already a column, so the title need not repeat it.
  const what = alert.title.startsWith(`${alert.node}/`)
    ? alert.title.slice(alert.node.length + 1)
    : alert.title.replace(new RegExp(`^${alert.node} `), "");

  return (
    <tr className={critical ? "bg-[var(--color-down)]/5" : undefined}>
      <td className="py-1 pr-2 whitespace-nowrap">
        <span className="flex items-center gap-1.5">
          <StatusDot status={critical ? "DOWN" : "DRAIN"} size={6} />
          <span className={`text-[10px] font-semibold uppercase ${
            critical ? "text-[var(--color-down)]" : "text-[var(--color-drain)]"
          }`}>
            {critical ? "crit" : "warn"}
          </span>
        </span>
      </td>

      <td className="py-1 pr-2 whitespace-nowrap font-mono">
        {nodeId != null ? (
          <Link to={`/nodes/${nodeId}`}
                className="text-[var(--color-accent)] hover:underline">
            {alert.node}
          </Link>
        ) : alert.node}
      </td>

      {/* Title and detail share a cell: the detail is the sentence that makes
          the title actionable, and a separate column would either wrap badly
          or be cut to uselessness. */}
      <td className="py-1 pr-2">
        <span className="text-slate-200">{what}</span>
        <span className="ml-2 text-[var(--color-mute)]" title={alert.detail}>
          {alert.detail}
        </span>
      </td>

      <td className="py-1 pr-2 whitespace-nowrap text-right text-[var(--color-mute)]"
          title={`Since ${new Date(alert.since * 1000).toLocaleString()}`}>
        {humanDuration(Math.round(alert.for_seconds))}
      </td>

      <td className="py-1 whitespace-nowrap text-right">
        {alert.state === "pending" ? (
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-mute)]"
                title="Live, but not yet long enough to have been announced">
            pending
          </span>
        ) : (
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-300"
                title="This has been sent to the webhook">
            sent
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Admin-only. Sets the webhook `alerting.run` delivers to, without a
 * redeploy - previously the only way to change it was
 * HAPROXYOPS_ALERT_WEBHOOK_URL, which still works and still wins if nothing
 * is set here.
 *
 * The URL itself is never shown once saved, the same way a node's stored
 * password never is: a webhook URL routinely embeds a bearer secret in its
 * path (Slack and Discord incoming webhooks both do), so round-tripping it
 * back to the browser would be handing out a working credential to view.
 */
function WebhookSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["alert-webhook"], queryFn: api.alertWebhook.get });
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSettled() {
    queryClient.invalidateQueries({ queryKey: ["alert-webhook"] });
    queryClient.invalidateQueries({ queryKey: ["alerts"] });
  }

  const save = useMutation({
    mutationFn: () => api.alertWebhook.set(url.trim()),
    onSuccess: () => {
      onSettled();
      setUrl("");
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not save the webhook"),
  });

  const clear = useMutation({
    mutationFn: () => api.alertWebhook.clear(),
    onSuccess: () => {
      onSettled();
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not clear the webhook"),
  });

  const source = status.data?.source;
  const statusText =
    source === "ui" ? "Configured from this page."
      : source === "env" ? "Configured via HAPROXYOPS_ALERT_WEBHOOK_URL, not from here."
        : status.isLoading ? "Checking…"
          : "Not configured - nothing is being delivered.";

  return (
    <Panel title="Delivery">
      <p className="mb-2 text-xs text-[var(--color-mute)]">{statusText}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (url.trim()) save.mutate(); }}
      >
        <input
          className={`${FIELD} max-w-md`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/…"
          aria-label="Webhook URL"
        />
        <button
          type="submit" disabled={!url.trim() || save.isPending}
          className="rounded bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-black disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          // Nothing to clear when the value in effect isn't the one stored
          // here - clearing the env var is not this button's job.
          disabled={source !== "ui" || clear.isPending}
          onClick={() => clear.mutate()}
          title={source !== "ui" ? "Nothing set from this page to clear" : undefined}
          className="rounded border border-ink-600 px-3 py-2 text-xs text-[var(--color-mute)] transition hover:text-slate-200 disabled:opacity-40"
        >
          {clear.isPending ? "Clearing…" : "Clear"}
        </button>
      </form>
      {error && (
        <p className="mt-2 text-xs text-[var(--color-down)]">{error}</p>
      )}
      <p className="mt-2 text-[11px] text-[var(--color-mute)]">
        Not shown once saved - a webhook URL routinely embeds a bearer secret in its path.
      </p>
    </Panel>
  );
}
