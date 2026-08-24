import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { IconButton, Panel, StatusDot } from "../components/ui";
import Modal from "../components/Modal";
import ConfirmDialog from "../components/ConfirmDialog";
import type { ManagedNode } from "../types";

const BLANK = {
  name: "",
  group: "default",
  driver: "dataplane",
  base_url: "https://",
  api_prefix: "/v3",
  stats_path: "/stats;csv;norefresh",
  username: "",
  password: "",
  prometheus_instance: "",
  verify_tls: true,
};

type FormState = typeof BLANK;

/** null while closed; otherwise create mode, or edit mode for one node. */
type Editing = { mode: "create" } | { mode: "edit"; node: ManagedNode } | null;

function formFrom(node: ManagedNode): FormState {
  return {
    name: node.name,
    group: node.group,
    driver: node.driver,
    base_url: node.base_url,
    api_prefix: node.api_prefix,
    stats_path: node.stats_path ?? BLANK.stats_path,
    username: node.username ?? "",
    // Never populated: the API stores it encrypted and does not return it.
    password: "",
    prometheus_instance: node.prometheus_instance ?? "",
    verify_tls: node.verify_tls,
  };
}

export default function Nodes() {
  const queryClient = useQueryClient();
  const { data: nodes = [], isLoading } = useQuery({
    queryKey: ["nodes"], queryFn: api.listNodes,
  });

  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState<FormState>({ ...BLANK });
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ManagedNode | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, string>>({});

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["nodes"] });

  const save = useMutation({
    mutationFn: () => {
      if (editing?.mode === "edit") {
        return api.updateNode(editing.node.id, editPayload(form, clearPassword));
      }
      return api.createNode(createPayload(form));
    },
    onSuccess: (_data, _vars) => {
      // A changed endpoint invalidates the last probe result.
      if (editing?.mode === "edit") {
        setTests((t) => {
          const next = { ...t };
          delete next[editing.node.id];
          return next;
        });
      }
      closeModal(true);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggle = useMutation({
    mutationFn: (node: ManagedNode) => api.updateNode(node.id, { enabled: !node.enabled }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (node: ManagedNode) => api.deleteNode(node.id),
    onSuccess: (_data, node) => {
      setTests((t) => {
        const next = { ...t };
        delete next[node.id];
        return next;
      });
      setDeleting(null);
      setDeleteError(null);
      invalidate();
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  function openCreate() {
    setForm({ ...BLANK });
    setClearPassword(false);
    setError(null);
    setEditing({ mode: "create" });
  }

  function openEdit(node: ManagedNode) {
    setForm(formFrom(node));
    setClearPassword(false);
    setError(null);
    setEditing({ mode: "edit", node });
  }

  function closeModal(force = false) {
    if (save.isPending && !force) return;
    setEditing(null);
    setError(null);
  }

  async function test(node: ManagedNode) {
    setTests((t) => ({ ...t, [node.id]: "testing..." }));
    try {
      const result = await api.testNode(node.id);
      setTests((t) => ({
        ...t,
        [node.id]: result.reachable
          ? `OK · ${result.version ?? "?"} · ${result.duration_ms}ms · ${result.capabilities.join(", ")}`
          : `FAILED · ${result.error}`,
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [node.id]: e instanceof Error ? e.message : "failed" }));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Nodes</h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110"
        >
          Add node
        </button>
      </div>

      <Panel title={`Managed nodes (${nodes.length})`}>
        {isLoading ? (
          <p className="text-sm text-[var(--color-mute)]">Loading...</p>
        ) : nodes.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-[var(--color-mute)]">No nodes registered yet.</p>
            <button
              type="button"
              onClick={openCreate}
              className="mt-3 rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-ink-700"
            >
              Add your first node
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wider text-[var(--color-mute)]">
                <tr>
                  <th className="pb-2">Name</th><th className="pb-2">Group</th>
                  <th className="pb-2">Transport</th><th className="pb-2">Endpoint</th>
                  <th className="pb-2">TLS</th><th className="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {nodes.map((node) => (
                  <tr key={node.id} className="align-top hover:bg-ink-800/60">
                    <td className="py-2">
                      <span className="flex items-center gap-2">
                        <StatusDot status={node.enabled ? "UP" : "MAINT"} />
                        {node.name}
                      </span>
                      {tests[node.id] && (
                        <p className={`mt-1 font-mono text-[11px] ${
                          tests[node.id].startsWith("OK")
                            ? "text-[var(--color-up)]" : "text-[var(--color-down)]"}`}>
                          {tests[node.id]}
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-[var(--color-mute)]">{node.group}</td>
                    <td className="py-2 text-xs">
                      {node.driver === "dataplane" ? `Data Plane ${node.api_prefix}` : "Stats CSV"}
                    </td>
                    <td className="py-2 font-mono text-xs text-[var(--color-mute)]">{node.base_url}</td>
                    <td className="py-2 text-xs">
                      {node.verify_tls
                        ? <span className="text-[var(--color-up)]">verified</span>
                        : <span className="text-[var(--color-drain)]">insecure</span>}
                    </td>
                    <td className="py-2">
                      <div className="flex justify-end gap-0.5">
                        <IconButton icon="edit" label="Edit node"
                                    onClick={() => openEdit(node)} />
                        <IconButton icon="test" label="Test connection"
                                    onClick={() => test(node)} />
                        <IconButton
                          icon={node.enabled ? "pause" : "play"}
                          label={node.enabled ? "Pause polling" : "Resume polling"}
                          variant={node.enabled ? "warn" : "good"}
                          onClick={() => toggle.mutate(node)}
                        />
                        <IconButton icon="trash" label="Remove node" variant="danger"
                                    onClick={() => { setDeleteError(null); setDeleting(node); }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <NodeModal
        editing={editing}
        form={form}
        error={error}
        busy={save.isPending}
        clearPassword={clearPassword}
        onClearPasswordChange={setClearPassword}
        onChange={setForm}
        onClose={() => closeModal()}
        onSubmit={() => save.mutate()}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Remove ${deleting?.name ?? "node"}?`}
        confirmLabel="Remove node"
        busy={remove.isPending}
        error={deleteError}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => {
          if (remove.isPending) return;
          setDeleting(null);
          setDeleteError(null);
        }}
      >
        <p>
          This removes <span className="font-medium text-slate-100">{deleting?.name}</span>{" "}
          from the dashboard, along with its stored credentials and cached state.
        </p>
        <p className="text-[var(--color-mute)]">
          The HAProxy instance itself keeps running and is not reconfigured. Its audit
          history and any Prometheus data are kept. You can register it again at any time.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Create: omit blanks entirely so the server applies its own defaults. */
function createPayload(form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = { ...form };
  for (const key of ["username", "password", "prometheus_instance"]) {
    if (!body[key]) delete body[key];
  }
  if (form.driver !== "stats_csv") delete body.stats_path;
  return body;
}

/**
 * Edit: a blank optional field means "clear it", sent as null.
 *
 * Password is the exception. The API never returns it, so the field always
 * renders empty - treating empty as "clear" would silently wipe the stored
 * credential of every node anyone opened and saved. Blank means unchanged;
 * clearing is a deliberate checkbox.
 */
function editPayload(form: FormState, clearPassword: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name,
    group: form.group,
    driver: form.driver,
    base_url: form.base_url,
    api_prefix: form.api_prefix,
    username: form.username || null,
    prometheus_instance: form.prometheus_instance || null,
    verify_tls: form.verify_tls,
  };
  if (form.driver === "stats_csv") body.stats_path = form.stats_path;
  if (form.password) body.password = form.password;
  else if (clearPassword) body.password = "";
  return body;
}

const FIELD =
  "w-full rounded border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

function NodeModal({
  editing, form, error, busy, clearPassword, onClearPasswordChange,
  onChange, onClose, onSubmit,
}: {
  editing: Editing;
  form: FormState;
  error: string | null;
  busy: boolean;
  clearPassword: boolean;
  onClearPasswordChange: (v: boolean) => void;
  onChange: (next: FormState) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });

  const [tab, setTab] = useState<TabId>("identity");
  // Reopening always starts on Identity: the previous node's tab is not a
  // useful default for the next one.
  useEffect(() => {
    if (editing) setTab("identity");
  }, [editing]);

  const isEdit = editing?.mode === "edit";
  const node = editing?.mode === "edit" ? editing.node : null;
  const isDataplane = form.driver === "dataplane";

  return (
    <Modal
      open={editing !== null}
      onClose={onClose}
      busy={busy}
      title={isEdit ? `Edit ${node?.name}` : "Add a node"}
      description={isEdit
        ? "Changes take effect on the next poll."
        : "Register an HAProxy instance for the dashboard to poll."}
      footer={
        <>
          <button
            type="button" onClick={onClose} disabled={busy}
            className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-slate-200 transition hover:bg-ink-700 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit" form="node-form" disabled={busy}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Saving..." : isEdit ? "Save changes" : "Add node"}
          </button>
        </>
      }
    >
      <form
        id="node-form"
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
        className="space-y-4"
      >
        <div role="tablist" aria-label="Node settings"
             className="flex gap-1 border-b border-ink-700">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`node-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`node-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`relative -mb-px px-3 py-2 text-sm font-medium transition ${
                tab === t.id
                  ? "text-slate-100"
                  : "text-[var(--color-mute)] hover:text-slate-200"
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span aria-hidden="true"
                      className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--color-accent)]" />
              )}
            </button>
          ))}
        </div>

        {/* Both panels stay mounted and the inactive one is hidden: the inputs
            are controlled, so unmounting would not lose data, but a required
            field on a hidden-by-unmount tab cannot be focused by the browser
            when submit fails validation. */}
        <div role="tabpanel" id="node-panel-identity" aria-labelledby="node-tab-identity"
             hidden={tab !== "identity"} className="space-y-5">
        <Section title="Identity">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Name" hint="Shown throughout the dashboard.">
              <input className={FIELD} required autoFocus value={form.name}
                     onChange={(e) => set("name", e.target.value)} placeholder="lb1.dc1" />
            </Labeled>
            <Labeled label="Group" hint="Clusters the fleet view.">
              <input className={FIELD} value={form.group}
                     onChange={(e) => set("group", e.target.value)} placeholder="edge" />
            </Labeled>
          </div>
        </Section>

        <Section title="Credentials">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Username" hint={isEdit ? "Blank clears it." : undefined}>
              <input className={FIELD} value={form.username} autoComplete="off"
                     onChange={(e) => set("username", e.target.value)} />
            </Labeled>
            <Labeled
              label="Password"
              hint={isEdit
                ? node?.has_password
                  ? "A password is stored. Leave blank to keep it."
                  : "No password stored."
                : "Encrypted at rest; never returned by the API."}
            >
              <input className={FIELD} type="password" value={form.password}
                     autoComplete="new-password" disabled={clearPassword}
                     placeholder={isEdit && node?.has_password ? "Unchanged" : ""}
                     onChange={(e) => set("password", e.target.value)} />
            </Labeled>
          </div>

          {isEdit && node?.has_password && (
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--color-mute)]">
              <input type="checkbox" checked={clearPassword}
                     onChange={(e) => onClearPasswordChange(e.target.checked)} />
              Remove the stored password
            </label>
          )}
        </Section>

        </div>

        <div role="tabpanel" id="node-panel-connection" aria-labelledby="node-tab-connection"
             hidden={tab !== "connection"} className="space-y-5">
        <Section title="Connection">
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Transport"
                     hint={isDataplane
                       ? "Full read and runtime actions."
                       : "Read-only: no actions against this node."}>
              <select className={FIELD} value={form.driver}
                      onChange={(e) => set("driver", e.target.value)}>
                <option value="dataplane">Data Plane API</option>
                <option value="stats_csv">Stats page (read-only)</option>
              </select>
            </Labeled>
            <Labeled label="API version" hint={isDataplane ? undefined : "Data Plane API only."}>
              <select className={FIELD} value={form.api_prefix} disabled={!isDataplane}
                      onChange={(e) => set("api_prefix", e.target.value)}>
                <option value="/v3">v3</option>
                <option value="/v2">v2</option>
              </select>
            </Labeled>
            <Labeled label="Base URL" wide
                     hint={isDataplane
                       ? "The Data Plane API endpoint, usually port 5555."
                       : "The stats page endpoint, usually port 8404."}>
              <input className={FIELD} required value={form.base_url}
                     onChange={(e) => set("base_url", e.target.value)}
                     placeholder={isDataplane
                       ? "https://lb1.dc1.example.com:5555"
                       : "https://lb1.dc1.example.com:8404"} />
            </Labeled>
            {!isDataplane && (
              <Labeled label="Stats path" wide hint="Must return the CSV export.">
                <input className={FIELD} value={form.stats_path}
                       onChange={(e) => set("stats_path", e.target.value)} />
              </Labeled>
            )}
          </div>

          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={form.verify_tls}
                   onChange={(e) => set("verify_tls", e.target.checked)} />
            <span>
              Verify TLS certificate
              {!form.verify_tls && (
                <span className="ml-2 text-xs text-[var(--color-drain)]">
                  Unverified TLS exposes a config-mutating API to interception.
                </span>
              )}
            </span>
          </label>
        </Section>

        <Section title="Metrics" optional>
          <Labeled
            label="Prometheus instance"
            hint="Leave blank - this is correct for almost every node. It matches any series whose instance label starts with the host from the address above, which is what both HAProxyOps' own built-in exporter and a node's native Prometheus exporter produce. Set it only if Prometheus's own instance label uses a different host than that address (e.g. a DNS name here, an IP there)."
          >
            <input className={FIELD} value={form.prometheus_instance}
                   onChange={(e) => set("prometheus_instance", e.target.value)}
                   placeholder="only needed if it differs from Base URL's host" />
          </Labeled>
        </Section>
        </div>


        {error && (
          <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-xs text-[var(--color-down)]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

type TabId = "identity" | "connection";

const TABS: { id: TabId; label: string }[] = [
  { id: "identity", label: "Identity and Credentials" },
  { id: "connection", label: "Connection" },
];

function Section({ title, optional, children }: {
  title: string; optional?: boolean; children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-mute)]">
        {title}
        {optional && (
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal">
            optional
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

function Labeled({ label, hint, children, wide }: {
  label: string; hint?: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label className="mb-1 block text-xs font-medium text-slate-300">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-[var(--color-mute)]">{hint}</p>}
    </div>
  );
}
