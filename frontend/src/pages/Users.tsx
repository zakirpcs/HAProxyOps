import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { IconButton, Panel, StatusDot } from "../components/ui";
import Modal from "../components/Modal";
import ConfirmDialog from "../components/ConfirmDialog";
import type { AppUser, Role } from "../types";

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "viewer", label: "Viewer", hint: "Read-only. Cannot change a server's state." },
  { value: "operator", label: "Operator", hint: "May drain, maint and return servers to rotation." },
  { value: "admin", label: "Admin", hint: "Everything, including adding nodes and users." },
];

const FIELD =
  "w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

/** Accounts, roles, and the lever for ending someone's sessions. */
export default function Users() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" as Role });
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AppUser | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const users = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const create = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setAdding(false);
      setForm({ username: "", password: "", role: "viewer" });
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not create the user"),
  });

  const revoke = useMutation({
    mutationFn: (user: AppUser) => api.revokeSessions(user.username),
    onSuccess: (_d, user) => {
      setRevoking(null);
      setRevokeError(null);
      setNotice(`Every session for ${user.username} has been ended.`);
    },
    onError: (e) => setRevokeError(e instanceof Error ? e.message : "Could not revoke sessions"),
  });

  if (users.isError) {
    // Match on the status code, not the message text.
    const error = users.error;
    const forbidden = error instanceof ApiError && (error.status === 401 || error.status === 403);
    return (
      <Panel title="Users">
        <p className="text-sm text-[var(--color-down)]">
          {forbidden
            ? "User management is available to administrators only."
            : (error as Error).message}
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold">Users</h1>
        <span className="text-xs text-[var(--color-mute)]">
          {users.isLoading ? "loading…" : `${users.data?.length ?? 0} accounts`}
        </span>
        <button
          type="button"
          onClick={() => { setAdding(true); setError(null); }}
          className="ml-auto rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110"
        >
          Add user
        </button>
      </div>

      {notice && (
        <p className="rounded border border-[var(--color-up)]/40 bg-[var(--color-up)]/10 px-3 py-2 text-sm text-[var(--color-up)]">
          {notice}
        </p>
      )}

      <Panel title="Accounts">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-[var(--color-mute)]">
              <tr>
                <th className="pb-2">User</th><th className="pb-2">Role</th>
                <th className="pb-2">State</th>
                <th className="hidden pb-2 sm:table-cell">Created</th>
                <th className="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {(users.data ?? []).map((user) => (
                <tr key={user.id} className="hover:bg-ink-800/60">
                  <td className="py-2 font-medium text-slate-100">{user.username}</td>
                  <td className="py-2">
                    <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-mute)]">
                      {user.role}
                    </span>
                  </td>
                  <td className="py-2">
                    <span className="flex items-center gap-2 text-xs">
                      <StatusDot status={user.is_active ? "UP" : "MAINT"} size={7} />
                      {user.is_active ? "active" : "disabled"}
                    </span>
                  </td>
                  <td className="hidden py-2 text-xs text-[var(--color-mute)] sm:table-cell">
                    {new Date(user.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2">
                    <div className="flex justify-end">
                      <IconButton
                        icon="pause" variant="warn"
                        label={`End every session for ${user.username}`}
                        onClick={() => { setRevoking(user); setRevokeError(null); }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!users.isLoading && (users.data?.length ?? 0) === 0 && (
          <p className="text-sm text-[var(--color-mute)]">No accounts.</p>
        )}
      </Panel>

      <Modal
        open={adding}
        onClose={() => !create.isPending && setAdding(false)}
        busy={create.isPending}
        title="Add user"
        description="A new account starts with the role you pick here."
        width="28rem"
        footer={
          <>
            <button type="button" onClick={() => setAdding(false)} disabled={create.isPending}
                    className="rounded border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-slate-200 disabled:opacity-40">
              Cancel
            </button>
            <button type="submit" form="user-form" disabled={create.isPending}
                    className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              {create.isPending ? "Creating…" : "Create user"}
            </button>
          </>
        }
      >
        <form id="user-form" className="space-y-3"
              onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-mute)]">Username</span>
            <input className={FIELD} value={form.username} autoComplete="off" required
                   minLength={2}
                   onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-mute)]">Password</span>
            <input className={FIELD} type="password" value={form.password} required minLength={8}
                   autoComplete="new-password"
                   onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <span className="mt-1 block text-xs text-[var(--color-mute)]">
              At least 8 characters. The API never returns it again.
            </span>
          </label>
          <fieldset>
            <legend className="mb-1 text-xs uppercase tracking-wider text-[var(--color-mute)]">Role</legend>
            <div className="space-y-1.5">
              {ROLES.map((role) => (
                <label key={role.value} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="role" className="mt-1" checked={form.role === role.value}
                         onChange={() => setForm({ ...form, role: role.value })} />
                  <span>
                    <span className="text-slate-200">{role.label}</span>
                    <span className="block text-xs text-[var(--color-mute)]">{role.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className="rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-xs text-[var(--color-down)]">
              {error}
            </p>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `End every session for ${revoking.username}?` : ""}
        confirmLabel="End sessions"
        variant="warn"
        busy={revoke.isPending}
        error={revokeError}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onClose={() => !revoke.isPending && setRevoking(null)}
      >
        <p>
          Every token issued to <strong>{revoking?.username}</strong> stops working
          immediately, on every device. The account is not disabled and the password
          is unchanged — they can sign in again straight away.
        </p>
        <p className="text-[var(--color-mute)]">
          Use this when a session may have leaked, or when someone leaves and the
          account has not been removed yet.
        </p>
      </ConfirmDialog>
    </div>
  );
}
