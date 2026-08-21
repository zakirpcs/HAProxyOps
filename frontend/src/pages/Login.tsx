import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, auth } from "../api";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      auth.set(result.access_token);
      navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-6">
        <h1 className="text-lg font-semibold">HAProxyOps</h1>
        <p className="mt-1 mb-5 text-sm text-[var(--color-mute)]">Sign in to manage your fleet.</p>

        <label className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-mute)]">Username</label>
        <input
          className="mb-4 w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
        />

        <label className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-mute)]">Password</label>
        <input
          type="password"
          className="mb-5 w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          value={password} onChange={(e) => setPassword(e.target.value)} required
        />

        {error && <p className="mb-4 rounded border border-[var(--color-down)]/40 bg-[var(--color-down)]/10 px-3 py-2 text-xs text-[var(--color-down)]">{error}</p>}

        <button
          type="submit" disabled={busy}
          className="w-full rounded bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
