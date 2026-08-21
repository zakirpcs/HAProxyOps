import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, auth } from "./api";
import Login from "./pages/Login";
import Fleet from "./pages/Fleet";
import NodeDetail from "./pages/NodeDetail";
import Nodes from "./pages/Nodes";
import Metrics from "./pages/Metrics";
import Alerts from "./pages/Alerts";
import Audit from "./pages/Audit";
import Users from "./pages/Users";
import FleetSearch from "./components/FleetSearch";
import Icon from "./components/Icon";
import { FleetProvider } from "./useFleet";
import FleetStatus from "./components/FleetStatus";
import type { Role } from "./types";

export default function App() {
  const location = useLocation();
  if (location.pathname === "/login") {
    return <Routes><Route path="/login" element={<Login />} /></Routes>;
  }
  if (!auth.token) return <Navigate to="/login" replace />;

  // The provider wraps the shell, not the other way round: the shell's status
  // indicator reads the same stream the pages do.
  return (
    <FleetProvider>
      <Shell>
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/nodes" element={<Nodes />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/users" element={<Users />} />
          <Route path="/nodes/:nodeId" element={<NodeDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </FleetProvider>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<{ username: string; role: Role } | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    api.me().then(setUser).catch(() => auth.clear());
  }, []);

  return (
    <div className="min-h-full">
      {/* z-30 deliberately: the fleet table has its own sticky header at z-10,
          and a bar that scrolling content can slide over is worse than none. */}
      <header className="sticky top-0 z-30 border-b border-ink-700/70 bg-ink-950/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-1 px-3 sm:px-5">
          <Link
            to="/"
            aria-label="HAProxyOps home"
            className="group mr-1 flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-accent)]/12 text-[var(--color-accent)] ring-1 ring-inset ring-[var(--color-accent)]/25 transition group-hover:bg-[var(--color-accent)]/20">
              <Icon name="logo" size={18} />
            </span>
            <span className="hidden text-[15px] font-semibold tracking-tight text-slate-100 sm:inline">
              HAProxy<span className="text-[var(--color-accent)]">Ops</span>
            </span>
          </Link>

          <span className="mx-3 hidden h-5 w-px bg-ink-700 sm:block" aria-hidden="true" />

          <nav aria-label="Main" className="flex h-full shrink-0 items-stretch gap-0.5">
            <NavItem to="/" label="Fleet" active={pathname === "/"} />
            <NavItem to="/metrics" label="Metrics" active={pathname.startsWith("/metrics")} />
            <NavItem to="/alerts" label="Alerts" active={pathname.startsWith("/alerts")} />
            <NavItem to="/nodes" label="Nodes" active={pathname.startsWith("/nodes")} />
            {/* Admin-only pages. They are guarded server-side too - hiding a
                tab is presentation, never the access control itself. */}
            {user?.role === "admin" && (
              <>
                <NavItem to="/audit" label="Audit" active={pathname.startsWith("/audit")} />
                <NavItem to="/users" label="Users" active={pathname.startsWith("/users")} />
              </>
            )}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
            <FleetSearch />
            <FleetStatus />
            <span className="mx-1 hidden h-5 w-px bg-ink-700 sm:block" aria-hidden="true" />
            {user && <UserChip username={user.username} role={user.role} />}
            <button
              type="button"
              onClick={async () => {
                // Revoke server-side first: dropping the local copy alone
                // leaves a working token behind for its full lifetime.
                await api.logout().catch(() => {});
                auth.clear();
                navigate("/login", { replace: true });
              }}
              className="flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-xs font-medium text-[var(--color-mute)] outline-none transition hover:border-ink-600 hover:bg-ink-800 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <Icon name="logout" size={13} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-3 py-4 sm:px-5 sm:py-6">{children}</main>
    </div>
  );
}

/**
 * A full-height tab with an accent rule along the header's bottom edge.
 *
 * The indicator sits on the border rather than floating inside a pill, so the
 * active section reads at a glance without the bar looking like a toolbar of
 * buttons.
 */
export function NavItem({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center rounded-t-md px-3 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? "text-slate-100"
          : "text-[var(--color-mute)] hover:bg-ink-800/70 hover:text-slate-200"
      }`}
    >
      {label}
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--color-accent)]"
        />
      )}
    </Link>
  );
}

const ROLE_STYLES: Record<Role, string> = {
  admin: "bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
  operator: "bg-[var(--color-drain)]/15 text-[var(--color-drain)]",
  viewer: "bg-ink-700 text-[var(--color-mute)]",
};

export function UserChip({ username, role }: { username: string; role: Role }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900 py-1 pl-1 pr-1 sm:pr-2.5">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-accent)]/15 text-[11px] font-semibold uppercase text-[var(--color-accent)]"
      >
        {username.slice(0, 1)}
      </span>
      {/* Collapses to the avatar on small screens; the name stays in the title. */}
      <span className="hidden items-center gap-1.5 sm:flex" title={`${username} (${role})`}>
        <span className="text-xs font-medium text-slate-200">{username}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          ROLE_STYLES[role] ?? ROLE_STYLES.viewer
        }`}>
          {role}
        </span>
      </span>
    </div>
  );
}
