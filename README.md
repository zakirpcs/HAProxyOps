# HAProxyOps

Central dashboard for a fleet of HAProxy instances: live frontend/backend/server
state across every node, plus runtime actions (ready / drain / maint / weight)
with RBAC and an audit trail.

Built for deployment on a dedicated RHEL-family server (RHEL, AlmaLinux, Rocky 9/10).

---

## How it talks to HAProxy

The dashboard is agent-light: it polls each node's management API and caches the
result. Two transports ship, selected per node.

| Driver | Source | Read state | Read config | Runtime actions |
|---|---|---|---|---|
| `dataplane` | HAProxy Data Plane API | yes | yes | ready / drain / maint |
| `stats_csv` | HTTP stats page CSV export | yes | no | no |

`dataplane` is the intended path. `stats_csv` exists so legacy nodes that cannot
run the Data Plane API still appear in the fleet view — read-only, with action
buttons disabled rather than the node being unsupported.

Adding a third transport (Runtime API over TCP, an SSH agent) means implementing
`HAProxyDriver` in `backend/app/drivers/` and registering it in `build_driver`.
Nothing above the driver layer knows which transport a node uses.

### Known transport differences

**Server addresses.** HAProxy does not populate the CSV `addr` column on the
HTTP stats page, even with `stats admin` — addresses come only from the Runtime
API. Nodes on `stats_csv` therefore show `-`; nodes on `dataplane` show real
addresses, because the Data Plane API reads through the runtime socket.

**Runtime endpoint paths differ between API versions.** v3 nests the server
under its backend (`/runtime/backends/{backend}/servers/{name}`); v2 takes the
backend as a query parameter. The driver picks the right shape from the node's
`api_prefix` — using the wrong one returns a bare 404.

**Weight cannot be changed at runtime.** The Data Plane API's `runtime_server`
model exposes only `address`, `admin_state`, `operational_state` and `port` —
there is no weight field in v2 or v3. `PUT .../weight` therefore answers 501
with an explanation, and the UI shows no weight control. Changing a weight
needs a configuration transaction and a reload, which arrives with config
editing (roadmap item 1).

All three verified against HAProxy 3.0 and Data Plane API v3.0.23.

---

## Fleet view

The fleet is a dense sortable table, one row per node — built for watching a
large number of instances rather than a handful:

- **Every column sorts.** Default order is *problems first*: unreachable nodes,
  then degraded ones, then healthy. Ties break on node name so rows never
  jitter between polls.
- **Filter** by node or group name, and a **Problems only** toggle that hides
  everything healthy.
- **Group** toggle breaks the table into per-group sections.
- **Age** column shows seconds since the last successful poll and turns amber
  past 60s, so a node whose poller has quietly stalled is visible.
- Sticky header, capped at 70vh so it stays put while scrolling; the less
  critical columns (group, version, uptime, rate, poll latency) drop out below
  the `lg` breakpoint.
- Rows are keyboard-focusable; Enter opens the node.

### Node state, and what counts as degraded

A node is **DOWN** when it cannot be reached at all, and **DEGRADED** when it is
reachable but has *active* servers down.

Backup servers are deliberately excluded from that judgement. A backup is
supposed to sit down while the primaries are healthy — HAProxy only routes to
one once every active server in the backend has failed — so counting it as
degradation would mark every node with a standby permanently amber, and a
status colour that is always on stops being read.

A down backup is still reported, just demoted:

| Signal | Meaning |
| --- | --- |
| **Down** column | Active servers down. Lost capacity, right now. |
| `N bck` badge | Backup servers down. No traffic lost; no fallback if the actives fail. |
| **Srv down** tile | Fleet-wide active servers down. |
| **Backups down** tile | Shown only when there are any. |

The same split applies to the `/api/fleet` summary: `servers_down` counts active
servers only, and `backups_down` is reported alongside it.

The distinction has to hold in four places that compute it independently — the
row state, the fleet summary in the provider, the API summary, and the
`problemCount` behind **Problems only**. If they drift, the count claims
problems the table will not show, so a test pins the badge to the filter.

### Adding and editing nodes

One modal serves both, built on the native `<dialog>` element rather than
a hand-rolled overlay — `showModal()` supplies focus trapping, Escape handling,
the top layer and an inert background, all of which are easy to get subtly
wrong by hand and all of which matter for a form that registers infrastructure.
The dialog refuses to dismiss while a submit is in flight, so a create is never
orphaned by a stray Escape or backdrop click.

The form is tabbed:

| Tab | Holds |
| --- | --- |
| **Identity and Credentials** | Name, group, username, password, remove-stored-password |
| **Connection** | Transport, API version, base URL, stats path, verify TLS, and the Prometheus instance |

Two tabs, not four sections in a scroll: *who the node is and how we sign in to
it* on one, *how we reach it* on the other. Every original section keeps its own
heading inside its tab, so Identity, Credentials, Connection and Metrics are all
still labelled — the tabs group them rather than replacing them.

The Prometheus instance sits with Connection rather than in a tab of its own:
it is another address for reaching the same node, so it belongs with the rest
of its addressing.

Hints change by transport — a `stats_csv` node is read-only, gets a Stats path
field, and takes port 8404 rather than the Data Plane API's 5555.

Both inactive panels stay mounted and are hidden with the `hidden` attribute
rather than unmounted. The inputs are controlled, so unmounting would not lose
data, but a required field on an unmounted tab cannot be focused by the browser
when submit validation fails — leaving a form that refuses to submit with
nothing visibly wrong. Panels are also kept in the same DOM order as the tab
strip, so keyboard and screen-reader traversal matches what is on screen.

The tab resets to **Identity and Credentials** every time the modal opens; the
previous node's tab is not a useful default for the next one.

**Blank means different things in the two modes, deliberately.** On create, a
blank optional field is omitted so the server applies its default. On edit, a
blank field is sent as `null` and clears the value — *except the password*.
The API never returns a stored password, so that field always renders empty;
treating empty as "clear" would silently wipe the credential of every node
anyone opened and saved. Blank leaves it alone, and removing it is a separate,
explicit checkbox.

### Action controls

Both Actions columns are icon buttons (`IconButton` + an inline SVG set in
`components/Icon.tsx` — no icon dependency, since the set is small and fixed).

`label` is a **required** prop, not optional: an icon carries no accessible
name of its own, so it supplies both the `aria-label` and the hover tooltip.
Without it the control is silent to a screen reader and a guess to everyone
else. The `<svg>` is `aria-hidden`, so the button's name is the label alone.

Labels lead with the action word — "Drain - finish existing sessions, accept no
new ones" — because drain and maint are domain terms an operator knows by name,
and an icon should remind rather than replace them. The Ready control is
disabled with an explanatory label when the server is already in rotation.

Hover colour carries the same meaning as the old button variants: amber for
drain and pause, red for maint and remove, green for ready and resume.

### Bulk operations

Servers on the node page carry a checkbox, and each backend header has a
select-all with a proper indeterminate state. Selecting anything raises a
sticky action bar — Ready, Drain, Maint, Clear — so a rolling restart across a
backend is one confirmation instead of one per server.

**Select-all covers only the servers the filter is currently showing.** A
filtered view that silently changes rows you cannot see is the wrong kind of
surprise.

#### The impact summary

Taking one server out at a time makes *this is the last one up* obvious.
Selecting twelve hides it completely, so the confirmation states plainly what
survives, per backend:

```
Backend     Selected   Active up
app-back    3 of 3       2 → 0     red
api-back    1 of 4       4 → 3     amber
```

and leads with a warning when a backend would be emptied — *"This takes every
active server out of app-back. Traffic to that backend will fail."*

Backup servers are **not counted as capacity**, for the same reason they do not
make a node [degraded](#node-state-and-what-counts-as-degraded): a standby is
meant to be down, and counting it as "still up" would mask exactly the case
this check exists to catch.

#### How it is applied

- **One request per server**, looped client-side, rather than a bulk endpoint.
  Each server keeps its own audit entry and its own RBAC check; a single
  endpoint would collapse a twelve-server drain into one log line.
- **Bounded concurrency (4).** `Promise.all` over a forty-server backend would
  open forty simultaneous connections to one load balancer's management API —
  the last thing worth doing while removing capacity from it.
- **Partial failure is expected, not exceptional.** One server refusing does
  not hide the eleven that worked: the failures are listed individually with
  their errors, and they *stay selected*, so retrying does not mean picking
  them again.

The logic lives in `src/bulk.ts` — separate from the page so the impact
assessment and the concurrency limit can be tested directly.

### Audit log

`/audit`, admin only. Every node change and every runtime action has been
written to an append-only table since the first release; this is the page that
reads it. For a tool that drains and maints production load balancers, *who
took web2 out at 3am* is a first-class question.

Each entry records the time, user, action, node, target, detail, source IP and
whether it succeeded. The filter spans **all** of those columns, and a
**Failures only** toggle narrows to attempts that did not take effect — usually
the more interesting ones. The page shows the 500 most recent entries and says
so; older history stays in the database.

### Users

`/users`, admin only. Add an account, see roles and state, and **end every
session** a user has — the revoke endpoint from
[Security model](#security-model).

The role picker explains each role rather than just naming it, because
"operator" does not say *may drain, maint and return servers to rotation*. The
revoke dialog is explicit that it is not the same as disabling an account:
tokens stop working everywhere immediately, the password is unchanged, and the
user can sign in again straight away.

Both pages are guarded server-side with `RequireAdmin`. Their nav tabs are
hidden from non-admins as well, but that is presentation — hiding a tab has
never been access control, and each page also handles a 403 by explaining who
may read it. That check reads the response **status**, not the message text:
the API returns FastAPI's `Forbidden`, which says nothing about roles.

### Timed maintenance windows

Taking a server out offers a window — 15 minutes, an hour, four hours — after
which the dashboard puts it back on its own. Forgetting to restore a drained
server is the usual way capacity stays quietly halved for days.

**Open-ended is the default.** A timed window is a promise, and one the
operator did not ask for should never be made on their behalf.

Holds live in Postgres, not Redis. If this state is lost the server never
returns, which is precisely the failure the feature exists to prevent, so it
belongs somewhere durable rather than in a cache that is safe to flush. The
poller sweeps expired holds on its normal cycle.

Auto-revert is a machine performing a runtime action unprompted, so three
things bound it:

- **Restoring means "stop holding it out", not "send it traffic".** `ready`
  clears the administrative block; HAProxy's health checks still decide what
  the server receives. A server that is still broken stays out, and the revert
  costs nothing.
- **A hold that no longer matches reality is abandoned, not enforced.** If the
  server is not in the state its hold applied — someone changed it by hand
  afterwards — that decision is newer, and overriding it would be worse than
  leaving the server held. A manual change to a server also supersedes any open
  hold on it immediately.
- **Failure is retried, never swallowed.** A node unreachable at expiry keeps
  its hold and is tried again next cycle. Dropping it is how a server stays
  drained forever.

Every transition is audited, including the automatic one, which appears under
the `system` user:

```
admin   maintenance.scheduled  app-back/web2  Returns to ready at … (1m).
system  maintenance.expired    app-back/web2  Returned to ready after the drain
                                              window set by admin ended.
```

### Confirming destructive actions

Every confirmation is a `ConfirmDialog` (built on the same `<dialog>`); there
are no native `confirm()` calls left. Cancel comes first in the DOM and carries
`autoFocus`, so a dialog opens with focus on the safe option and a stray Enter
dismisses rather than confirms.

**Server state changes** (drain / maint) show what the action does *and what it
does to the backend*. Drain stops new sessions and lets existing ones finish;
maint drops them. If the target is the last active server, the dialog says so
before you click — either "traffic will fail over to N backup servers", or, if
there is no healthy backup, that the backend will have nothing left to route to
and will stop serving traffic. That is the question a native `confirm()` could
not answer, and the reason for replacing it. Returning a server to `ready` is
the restorative direction and applies without a prompt.

One dialog serves the whole page rather than one per row — a `<dialog>` element
per server would be hundreds of them on a busy node.

Removing a node uses the same `ConfirmDialog`, which
states what the action does *and what it does not*: the HAProxy instance keeps
running and is not reconfigured, and its audit history and Prometheus data are
kept. Cancel carries `autoFocus` and comes first in the DOM, so the dialog opens
with focus on the safe option and a stray Enter dismisses rather than deletes.

That replaced a native `confirm()`, which also hid a real bug: the delete
mutation had no `onError`, so a rejected delete was indistinguishable from a
successful one. Failures now surface inside the dialog.

Editing exposed two gaps in `PATCH /api/nodes/{id}` that create had covered but
update did not: renaming onto an existing name hit the unique constraint as a
500 (now a 409), and `NodeUpdate` carried no validators, so an edit could store
a `base_url` or `api_prefix` that a create would have rejected (now 422).

### Refresh control

State is pushed over SSE, so the table has no polling loop of its own. The
**Refresh** selector controls how often the view *commits* what has arrived —
Live, 5s, 10s, 30s, 60s, or Paused — and the choice persists in localStorage.

The setting is app-wide, not per page: there is one shared stream, so there is
one cadence. Pausing on the fleet table also pauses the node page, which is why
the shell's status indicator shows `PAUSED` and the count of held updates
rather than letting a frozen page look like stale data.

The stream stays connected in every mode. Buffered snapshots land in a ref
rather than React state, so a paused table costs no renders no matter how
chatty the fleet is, and resuming shows current state instead of replaying a
backlog. A badge on the **Refresh** button counts held updates; the button
itself forces a REST resync and commits immediately.

Two reasons this is worth having beyond taste: rows re-sort as health changes,
so a live table moves under the cursor exactly when you are trying to click a
degraded node; and the **Age** column's staleness threshold scales with the
selected interval (`max(60s, interval × 2)`), so a 60s refresh does not paint
every row amber for behaving normally.

This is a *client-side* control — it does not change how often the server polls
your HAProxy nodes. That is `HAPROXYOPS_POLL_INTERVAL_SECONDS` (default 10),
and it is the knob that affects load on the load balancers themselves.
Selecting an interval shorter than the server's poll interval gains nothing.

Rows are plain DOM. That is comfortable into the high hundreds; past that,
virtualise the row list before doing anything else.

## App shell

A sticky top bar carries the brand mark, the section tabs, live fleet health,
and the signed-in user. The active tab is marked with `aria-current="page"` and
an accent rule on the header's bottom edge; a node detail page (`/nodes/:id`)
activates **Nodes**, following the URL rather than leaving no tab lit.

The header sits at `z-30` deliberately. The fleet table has its own sticky
header at `z-10`, and two stacking peers meant table rows could slide over the
bar while scrolling.

### Fleet-wide search

A search box in the bar answers *which node serves this?* — the question that
stops being answerable by eye somewhere around the tenth node. It matches
frontend, backend and server names, plus server addresses, across every
snapshot the server holds, and a result navigates straight to its node.

- **`/` focuses it**, Escape closes it.
- **Debounced at 250 ms**, and it ignores anything under two characters: one
  letter matches most of a fleet, and a request per keystroke rescans every
  snapshot for a word the operator has not finished typing.
- The server caps results at 200 and the list shows 12; when there are more,
  it says how many are **not** shown rather than truncating silently.

### Fleet status indicator

The bar shows fleet health on every page, so a node going down while you are
buried in one node's server list is still visible:

```
● 14/14 nodes healthy            all reachable, stream live
● 14/14 nodes  3 srv down        trouble inside otherwise reachable nodes
● 12/14 nodes  2 down  9 srv down  nodes unreachable
● 14/14 nodes healthy  PAUSED · 7   7 updates held by the refresh mode
● 14/14 nodes healthy  OFFLINE      stream dropped
```

**The dot tracks the stream, not the fleet.** A red fleet you are watching and
a fleet you have stopped receiving are different problems, and one dot for both
hides the second — the worse of the two, because everything looks fine while
you are flying blind. Fleet trouble is carried by the coloured counts instead,
and the tooltip spells all of it out.

`servers_down` gets its own count because it is the common case and invisible
from the node totals alone: every node reachable, several pool members dead.

### One stream per tab

Fleet state lives in a `FleetProvider` mounted above the shell, not in a hook
each page calls. Every call to the old hook opened its own `EventSource`, so a
node page ran two streams, and adding an indicator to the shell would have made
it three. One provider means one stream however many components read from it —
and it survives client-side navigation, so moving between Fleet and a node page
opens nothing new and keeps the buffer.

`useFleet()` throws outside a provider rather than returning empty state; the
alternative failure mode is an empty fleet that looks like a backend outage.

To check it on a running instance:

```bash
docker compose logs api | grep -c "GET /api/events"
```

Expect one per open tab. Navigating must not increase it; a full page reload
legitimately adds one, since the old connection closes as the page unloads.

## Architecture

```
                    ┌──────────── Dashboard server (RHEL) ────────────┐
                    │                                                  │
  Browser ──443──▶  │  nginx ──▶ haproxyops-web  (SPA, static)          │
                    │     └────▶ haproxyops-api  ──▶ PostgreSQL         │
                    │                  │             (inventory, users, │
                    │                  │              audit log)        │
                    │                  ├──▶ Redis (snapshot cache +     │
                    │                  │           SSE pub/sub)         │
                    │            poller task                            │
                    └──────────────────┼───────────────────────────────┘
                                       │ HTTPS + mTLS
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
     lb1 :5555 (dataplane)      lb2 :5555 (dataplane)     lb9 :8404 (stats only)
```

**Browsers never trigger a poll.** The poller owns every connection to every
node and writes snapshots into Redis; the API serves reads from Redis and
pushes updates to browsers over SSE. Load on the HAProxy boxes stays flat
regardless of how many dashboards are open.

Nodes are polled concurrently (bounded by `POLL_CONCURRENCY`), so a fleet of 50
refreshes in roughly the time of the slowest node, not the sum of all of them.

---

## Quick start (containers)

```bash
docker compose up -d --build
./demo/seed.sh                 # registers the bundled demo HAProxy node
```

Open <http://localhost:8080> and sign in as `admin` / `haproxyops`.

The demo fleet ships with servers that are down on purpose, so the dashboard has
real failures to render: `web3` on the edge nodes is a **backup** pointed at a
dead port, and `api3`, `legacy1` and `legacy2` on the internal nodes are
**active** servers pointed at dead ports. So the edge nodes read UP with a
`1 bck` badge, and the internal nodes read DEGRADED — see
[Node state](#node-state-and-what-counts-as-degraded).

The stack includes a demo HAProxy node (`demo/haproxy.cfg`) fronting two
`whoami` containers, with a third backup server pointed at a dead port so the
fleet view has a realistic degraded backend. It runs the Data Plane API
alongside HAProxy and is registered with the `dataplane` driver, so the
ready / drain / maint buttons work against it.

| Port | Service |
|---|---|
| 8080 | Dashboard UI (nginx, proxies `/api`) |
| 8000 | API directly (`/docs` for OpenAPI) |
| 9090 | Demo Prometheus |
| 5555 | Demo node's Data Plane API |
| 8404 | Demo node's HAProxy stats page |
| 8081 | Demo node's proxied app |

Tear down with `docker compose down -v`.

## Quick start (development)

```bash
# 1. Dependencies
docker compose up -d redis

# 2. Backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env                # set HAPROXYOPS_SECRET_KEY
.venv/bin/uvicorn app.main:app --reload

# 3. Frontend
cd ../frontend
npm install && npm run dev          # http://localhost:5173
```

Sign in as `admin` with `HAPROXYOPS_INITIAL_ADMIN_PASSWORD` (default `changeme`).
The bootstrap admin is created only when the user table is empty.

### Metrics page

Graphs live on their own page, chosen from a node dropdown, rather than on the
node page. The two answer different questions: the node page is *what is this
node doing right now*, and the graphs are *how has it behaved over the last few
hours* — usually asked while comparing nodes, not while drilling into one.

The picker is grouped by node group and the choice is remembered across visits.
A remembered node that has since been deleted falls back to the first one rather
than blanking the page. Selecting an unreachable node still renders its graphs,
with a warning: Prometheus keeps its own history, so the last datapoint would
otherwise read as the node's current state.

### Configuration and diff

`/config` shows a node's declared frontends and backends, and can diff two
nodes side by side. It answers *why does lb-edge-2 behave differently from
lb-edge-1* — otherwise unanswerable from the dashboard, which shows what each
node is **doing** but never what it was **told**.

Read-only, and matched by proxy name: "the same backend on both nodes" means
the same name, since file order is meaningless across hosts. Differences and
one-sided proxies sort above identical ones, which are collapsed to a single
line — you did not open the page for the parts that match.

Two comparisons are deliberately *not* reported as differences:

- **Null versus absent.** In HAProxy an unset option and one the API reports as
  `null` mean the same thing, so treating them as different invents a
  difference that does not exist.
- **The `from` field**, which names the anonymous defaults section a proxy
  inherits. The Data Plane API numbers those per file, so two identical configs
  routinely disagree on it.

Array order *is* compared, because rule order is behaviour in HAProxy — sorting
rule lists before comparing would hide a reordering that changes routing.

Dynamic targets are recognised rather than mistaken for faults. HAProxy allows
a fetch expression as a `use_backend` target — `use_backend
%[req.hdr(x-tenant),lower]` — and the Data Plane API reports that expression
verbatim as the rule's name. It matches no backend that exists, so it used to
be reported as a backend that had stopped reporting, complete with a warning
that the running and loaded configs disagreed. Nothing was wrong: the backend
is chosen per request. It is now shown as exactly that, and no longer drags the
service's health down.

Nodes on the stats-page driver cannot serve configuration; the page says so
rather than showing a bare `501`.

### Editing configuration

Admin only, on the Config page behind an **Edit** toggle, and offered only when
a single node is in view — comparing two nodes while editing one is a good way
to edit the wrong one.

The flow is read → edit → validate → apply, and the safety is HAProxy's rather
than this UI's:

- **Validation is HAProxy's own.** The same check runs on apply, so an invalid
  config cannot be written even if the screen is bypassed. A rejection carries
  HAProxy's own diagnostic — *"unable to find required default_backend: 'x'"* —
  not a generic failure.
- **The node checks the version.** An edit based on a stale read is refused with
  a 409, so a concurrent edit cannot be silently overwritten. This is checked by
  the node, not here: anything else would be a race, because the config can
  change between the read and the write.
- **Applying requires validating first.** The server would validate anyway;
  requiring it in the UI is what makes an operator *read* the result rather than
  clicking past it. Any further edit re-arms the gate, because the previous
  result was for different text.

Reading the raw config is admin-only too, not just writing: a full config can
contain `userlist` credentials, TLS paths and internal addressing that an
operator with drain rights has no reason to see.

Both attempts and outcomes are audited. A failed apply is recorded *before* it
is raised, so a config that takes a node down still leaves a record of who
applied it.

**The Data Plane API rewrites the file rather than storing it verbatim.** It
prepends its own `_md5hash` and `_version` comments, re-indents, and drops bare
comment lines. Every directive survives — verified by round-tripping a real
config and confirming each section — but formatting and blank-line comments do
not. The editor says so above the text area, because finding your file
reformatted after a deploy is otherwise an unpleasant surprise.

### Service view

The node page groups each frontend with the backends it routes to, read from
`default_backend` and `use_backend` rules rather than guessed from names. A
backend reachable from several frontends appears in each of their sections and
is marked `shared`; one that no frontend routes to is listed separately under
**Unrouted backends** rather than being dropped.

Routing comes from the configuration, so it is cached against the Data Plane
API's config version and refetched only when that changes — a steady node costs
one extra request per poll, not one per frontend. Transports that cannot read
configuration (the stats-page driver) fall back to flat frontend and backend
lists and say why.

Interactive API docs: <http://localhost:8000/docs>

### Running the tests

```bash
python3 scripts/check-text-files.py             # source files are plain text
cd backend && .venv/bin/python -m ruff check .  # lint
cd backend && .venv/bin/python -m pytest -q     # drivers, routing, parsers
cd frontend && npm test                         # components and the fleet stream
```

`.github/workflows/ci.yml` runs all four, plus `npm run build`. All are gates —
none is advisory, so a red build means something to fix rather than something to
scroll past.

The text-file check exists because of a defect that reached the repository: a
stray NUL byte in `bulk.ts`, used as a join separator. It compiled, it ran, and
every test passed — a NUL round-trips through a join and split exactly as
reliably as a space. What it broke was the tooling: `grep` and `file` treat such
a file as binary and skip it **silently**, so a search across the codebase
missed it without saying so. A second file had the same defect. The check reads
bytes rather than asking `file`, whose heuristics call short or unusual files
binary when they are fine.

`npm test` runs Vitest once; `npm run test:watch` keeps it running. Tests live
next to the code they cover (`src/services.test.ts`, `src/useFleet.test.tsx`).

The frontend suite is jsdom-based rather than snapshot-based, because the bugs
worth catching here only appear once a component is mounted. Two examples of
what it pins down:

- **One EventSource per tab.** `src/test/sse.ts` installs a fake EventSource —
  jsdom has none — and the provider tests assert a single connection survives
  client-side navigation. Reintroducing the old stream-per-hook design fails
  four of them. This was previously only checkable by reading the server's
  connection log.
- **Icon buttons have accessible names.** An icon carries no text, so every
  variant is asserted to expose a matching `aria-label` and `title` over an
  `aria-hidden` svg.
- **The fleet table's ordering rules.** Problems sort to the top, numeric
  columns open descending, and ties fall back to name so rows do not jitter
  between polls. That last one needs care to test: V8's sort is stable and the
  provider already emits rows in name order, so the fixture deliberately gives
  two tied nodes groups that invert their names. Without it the assertion
  passes whether the tie-break exists or not.
- **The runtime action flow**, which is the part that changes a live load
  balancer. Drain and maint must ask first and send nothing until confirmed;
  cancelling must send nothing at all; `ready` applies straight away because
  returning a server to rotation is the restorative direction; a failure stays
  in the dialog rather than closing it. One shared dialog serves the whole page,
  so there is also a test that the row's own server is the one targeted.

`npm run build` type-checks the tests too, so a test that drifts from the code
it covers breaks the build rather than rotting quietly.

---

## Production deployment (RHEL family)

### 1. Prepare each HAProxy node

```bash
# On every managed node, as root:
DASHBOARD_IP=10.0.0.20 ./deploy/haproxy-node/prepare-node.sh
```

Then merge `deploy/haproxy-node/haproxy-snippet.cfg` into `/etc/haproxy/haproxy.cfg`
and install `deploy/haproxy-node/dataplaneapi.yml` at `/etc/haproxy/dataplaneapi.yml`,
adjusting addresses and certificate paths. Validate before reloading:

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy
```

The snippet is not applied automatically — every fleet's config layout differs,
and silently rewriting a load balancer's config is not something this tool does.

### 2. Install the dashboard server

```bash
sudo ./deploy/docker/install.sh
```

This builds both images, generates secrets, installs the compose project into
`/etc/haproxyops/`, registers a systemd unit, configures nginx and firewalld,
and starts everything. One `haproxyops.service` owns the whole stack, because
Docker has no systemd generator of its own:

```bash
systemctl status haproxyops
docker compose -f /etc/haproxyops/docker-compose.yml ps
docker compose -f /etc/haproxyops/docker-compose.yml logs -f api
```

The production compose file is *not* the one at the repo root: it runs prebuilt
images, publishes only to `127.0.0.1` behind the host's nginx, and reads secrets
from files rather than the environment.

### RHEL specifics handled

- **SELinux**: volume mounts use `:Z`; `httpd_can_network_connect` is set so
  nginx can reach the containers. The node prep script labels the Data Plane
  API and stats ports with `semanage port`.
- **firewalld**: 80/443 on the dashboard host. On each managed node, the Data
  Plane API and stats ports are opened by *rich rule to the dashboard's IP only*,
  not to the zone.
- **Secrets**: files under `/etc/haproxyops/secrets/`, mounted into the
  containers as Docker secrets at `/run/secrets/` and read by pydantic-settings'
  `secrets_dir`. They never enter the environment, so `docker inspect` does not
  expose them. The directory is `0700 root`, which is what keeps non-root host
  users out; the files themselves are `0640 root:root` because the API image
  runs as uid 1001 with gid 0 and can only read them through the root group.
  `install.sh` generates all three on first run and never overwrites an
  existing one:
  - `haproxyops-secret-key` - signs JWTs *and* derives the Fernet key that
    encrypts node credentials at rest. Back it up. Losing or rotating it
    makes every stored node password unrecoverable and they must be
    re-entered by hand.
  - `haproxyops-database-url` - includes the generated Postgres password.
  - `haproxyops-admin-password` - the bootstrap admin password, printed once
    by the installer. There is no `changeme` default in production; the
    account is created only while the user table is empty, so the secret is
    inert on every start after the first.
- **Containers** run non-root, read-only, with `NoNewPrivileges` and all
  capabilities dropped.

---

## Security model

- **Failed logins are throttled** per source address *and* per username, in
  Redis so the limit holds across workers and restarts: 10 failures in 5
  minutes locks the key for the rest of the window, answering 429 with
  `Retry-After`. Both counters matter — the address one stops a single host
  grinding a password list, the username one stops the same guesses being
  spread across many addresses. A correct password clears both, and the window
  is fixed from the first failure rather than extended by each one, so nobody
  can hold an account locked out indefinitely. It fails **open** if Redis is
  down and logs loudly: locking every operator out of the dashboard during a
  cache outage is the worse failure.
- **Credentials are stripped from application logs.** `EventSource` cannot set
  headers, so the SSE endpoint takes its JWT as a query parameter, and uvicorn
  logs the full request line — putting a token valid for its whole lifetime
  into journald and `docker logs`. A logging filter rewrites `token`,
  `password`, `secret` and `api_key` values to `[REDACTED]` on every logger
  that can carry a request line. It scrubs the record's positional args as well
  as its message, because uvicorn passes the request line as an arg and formats
  it later.
- **Tokens are revocable.** A JWT is otherwise valid until it expires, which
  with a 12-hour lifetime outlives a password change, an account being
  disabled, and the operator noticing. Two mechanisms, both in Redis, both
  keyed so they expire on their own rather than growing without bound:
  - `POST /api/auth/logout` denies the presented token by its `jti`, for
    exactly its remaining lifetime. **Sign out** in the UI calls this before
    clearing local state — dropping the browser's copy alone leaves a fully
    valid token alive for hours.
  - `POST /api/auth/users/{username}/revoke` (admin) records a cut-off, and
    every token that user holds is refused from that moment. It is the lever
    for a compromised account or a departure, and it needs no list of sessions
    because none was ever stored. Signing in again works immediately.

  The check fails **open** if Redis is unreachable, narrowly and on purpose:
  the token is still signed, unexpired, and its account still active, all
  verified against Postgres. Refusing every request because a cache is down
  turns a cache outage into an outage of the tool you fix outages with.
- **Content-Security-Policy** is served by both nginx configs:
  `default-src 'self'` with `script-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'` and `base-uri 'self'`. The app loads one module script
  and one stylesheet, both same-origin, and talks only to its own `/api`, so
  nothing needs relaxing — **except `style-src`, which still carries
  `'unsafe-inline'`**: the UI sets inline style *attributes* from JavaScript
  (chart series colours, the modal's width variable) and CSP counts those as
  inline style. Dropping it means moving those few values into CSS custom
  properties set by class.
- **Transport to nodes**: HTTPS with certificate verification on by default.
  mTLS is strongly recommended — the Data Plane API can mutate a load balancer's
  configuration, so anything able to route to that port and guess a password is
  a serious problem. Client certificate paths are per-node.
- **Node credentials** are Fernet-encrypted at rest with a key derived from
  `HAPROXYOPS_SECRET_KEY`, and are never returned by the API (`NodeOut` exposes
  only `has_password`). Rotating the secret key invalidates stored credentials
  by design; they must be re-entered.
- **RBAC**: `viewer` < `operator` < `admin`. Viewers read. Operators additionally
  perform runtime actions. Admins manage nodes, users, and read the audit log.
- **Audit**: every mutating call — including failed ones — is written to
  `audit_log` with the actor, target, and source IP.
- **SSE and the JWT**: `EventSource` cannot set an `Authorization` header, so
  `/api/events` also accepts `?token=`. Two layers keep it out of logs: the
  nginx format in `deploy/nginx/haproxyops.conf` logs `$uri` rather than
  `$request`, and the application redacts the value itself, so uvicorn's own
  access log is safe too — that one was leaking whole tokens into `docker logs`
  and journald until it was fixed. If you put another proxy in front, make sure
  it does the same. Should a token leak anyway, `POST /api/auth/logout` and the
  per-user revoke endpoint above end it without waiting out the expiry.

---

## Scaling

The poller runs inside the API process's lifespan, so **one API replica means
one poll loop** — which is why the Containerfile pins `--workers 1`. That is
comfortable well past a hundred nodes, since polling is I/O-bound and
concurrent.

To run multiple API replicas, split the poller into its own process first
(`poll_loop` is already self-contained) and leave the API replicas stateless
readers of Redis. Running two replicas as-is would double the poll rate against
every node.

---

## Alerting

The status indicator only helps while somebody is looking at the screen. This
covers the other twenty-three hours. Off unless a webhook is configured — with
none set, nothing is evaluated and no state is kept:

```bash
HAPROXYOPS_ALERT_WEBHOOK_URL=https://hooks.example.com/haproxyops
HAPROXYOPS_ALERT_FOR_SECONDS=60        # how long a problem must last
HAPROXYOPS_ALERT_REPEAT_SECONDS=3600   # 0 disables repeats
```

### The Alerts page

`/alerts` shows what is wrong right now, evaluated from the same rules the
notifier uses — so it is not a second opinion that can disagree with the
messages people receive, it is the same assessment shown rather than sent.

It works with no webhook configured, and says so prominently when there is
none: the page is useful either way, and it doubles as a preview of what
alerting *would* deliver, but silence must never be mistaken for health.

Each alert is marked **sent** or **pending**. Pending means live but not yet
old enough to have been announced — a real state, not a rounding of "firing",
and calling it sent would be a lie. Critical sorts above warning, then longest
running first.

One row per alert rather than a stack of cards: a fleet in real trouble
produces dozens at once, and a page you have to scroll to count is one that
hides the scale of the problem. The node has its own column and links through,
so the alert text does not repeat it.

### What fires

| Condition | Severity |
| --- | --- |
| A node is unreachable | critical |
| A backend has no active server up | critical |
| A backend has lost some but not all active servers | warning |

A **disabled node is silent** — polling is off deliberately, and alerting on it
would punish an operator for having said so. An **unreachable node reports only
itself**: its backends cannot be judged from a snapshot that failed, and
inventing outages from missing data turns one problem into a dozen. A **down
backup is never an alert**, for the same reason it does not make a node
[degraded](#node-state-and-what-counts-as-degraded).

### Not crying wolf

The hard part is not detecting a problem; it is staying worth reading.

- **Alerts fire on a transition, not on a state.** A backend down for an hour is
  one message, not one per poll cycle.
- **A problem must persist** for `ALERT_FOR_SECONDS` before it is announced. A
  node restarting trips every rule here for a few seconds and resolves itself.
- **A flap that never fired never resolves.** Something that cleared before the
  delay was never anyone's business, and a resolution for an alert nobody saw
  is pure noise.
- **Recovery is announced**, carrying the key that fired so a receiver can close
  its own incident. An alert that never resolves teaches people to ignore the
  channel.
- **State lives in Redis**, so a redeploy does not re-announce every problem the
  fleet already has.

### Delivery

One JSON POST per alert: `status` (firing/resolved), `severity`, `title`,
`detail`, `node`, `key`, `labels`, `source`, `at`. Flat and generic on purpose —
readable by a human through a Slack or Discord incoming webhook, parsable by
anything else, without pretending to be Alertmanager's schema.

Delivery never raises. A webhook being down is worth a log line, not an outage
of the tool people use to see the outage — evaluation runs after snapshots are
stored, so the dashboard never waits on a receiver.

## Metrics and history

HAProxyOps stores **no time series of its own** — it owns control and current
state. Trends on the [Metrics page](#metrics-page) come from Prometheus scraping
the exporter HAProxy 2.0+ serves natively on its stats port (no sidecar, nothing
to install on the nodes).

Set `HAPROXYOPS_PROMETHEUS_URL` to enable graphs. Without it the metrics
section renders a one-line explanation instead of breaking the page.

Four panels per node, over 15m / 1h / 6h / 24h:

| Panel | Query |
|---|---|
| Current sessions | `haproxy_frontend_current_sessions` by frontend |
| HTTP requests | `rate(haproxy_frontend_http_requests_total[2m])` by frontend |
| Backend errors | connection + response error rate, by backend |
| Frontend throughput | bytes in and out across all frontends |

**Panels are defined server-side** (`backend/app/metrics.py`), not built from
PromQL sent by the browser. A dashboard that forwards arbitrary queries is an
open proxy into the metrics estate; a fixed panel set also keeps the UI a dumb
renderer.

Each node needs to be matched to its scrape target. Set `prometheus_instance`
on the node (e.g. `lb1.example.com:8404`); when unset it falls back to matching
any port on the host in `base_url`, since the scrape target is the stats port
while `base_url` points at the Data Plane API.

### Charts

Hand-rolled SVG — no charting dependency. Worth knowing about the choices:

- **Colour follows the entity, not its rank.** Panels use `topk()`, so series
  reorder between refetches as load shifts. Assigning colour by array index
  would repaint the survivors and break the reader's "http-in is the blue one";
  a series name keeps the slot it was first given.
- **Six series maximum**, capped server-side by `topk()`. Past that the tail is
  dropped rather than given a generated seventh hue, which would be
  indistinguishable from an existing one to a colourblind reader.
- The palette is the validated dark-mode categorical set, **re-checked against
  this app's chart surface** (`#11151d`) rather than assumed: lightness band,
  chroma floor, CVD separation, normal-vision floor and 3:1 contrast all pass
  for all six slots.
- Crosshair and tooltip on hover; a legend whenever there are 2+ series, plus
  direct end-labels at 4 or fewer, so identity never rests on colour alone.
  End-labels truncate from the middle — proxy names share prefixes, and
  `internal-api` / `internal-web` both collapsing to `internal...` makes a
  label worse than none.
- A **Table** toggle shows the same numbers for anyone the plots do not serve.
- `null` values are real gaps and break the line rather than interpolating
  across an outage.

### Schema changes

Alembic, applied automatically at startup. `init_models()` upgrades the
database to head; there is no `create_all` path any more.

```bash
cd backend
.venv/bin/alembic revision --autogenerate -m "what changed"
.venv/bin/alembic upgrade head        # or just restart the API
.venv/bin/alembic upgrade head --sql  # emit SQL for review instead
```

The URL comes from the application's settings, not `alembic.ini`. In production
it contains the Postgres password and is read from a mounted secret;
duplicating it into a config file would put a credential back in the repo.

**A database created before migrations existed is adopted, not rebuilt.** It has
every table but no `alembic_version`, so running the baseline against it would
fail on "table already exists". Startup detects that, stamps the baseline as
already satisfied, and applies anything newer. Verified against a live Postgres
with four registered nodes and sixteen audit rows: adopted once, data intact,
and the stamp holds across restarts.

Auto-applying at startup suits a single API container behind nginx — an
operator upgrading the image should not also have to remember a manual step.
**Run several replicas and this has to move to a job that runs once before they
start**, because two of them migrating simultaneously is a race.

`compare_type` and `compare_server_default` are on, so a column changing type or
nullability is detected; without them, half the point of migrations is lost.
SQLite uses batch mode, since it cannot `ALTER` most things in place — the same
migration then works on a developer's SQLite and on production Postgres.

---

## Layout

```
backend/app/
  drivers/        transport layer — dataplane, stats_csv, shared normalisation
  routers/        auth, nodes (CRUD), fleet (reads), actions, events (SSE)
  poller.py       concurrent refresh loop
  state.py        Redis snapshot cache + pub/sub
  models.py       Node / User / AuditLog
frontend/src/
  useFleet.tsx    FleetProvider — REST priming + SSE deltas, one stream per tab
  services.ts     frontend -> backend grouping used by both views
  components/     shell chrome, charts, modals, service views
  pages/          Fleet, NodeDetail, Nodes, Login
deploy/
  docker/         production compose project + systemd unit + installer
  nginx/          TLS edge
  haproxy-node/   what to install on each managed node
```

## Roadmap

### Known debt

Things already load-bearing that will need work before they bite:

- **The modal shim.** jsdom implements `<dialog>` as an element but not its
  modal behaviour, so `src/test/setup.ts` supplies `showModal`/`close` and the
  `close` event. Tests therefore cover the flow around a dialog — what opens it,
  what closes it, what is sent — but *not* focus trapping, the top layer, or
  background inertness. Those are the browser's, and only a real one can vouch
  for them.
- **Row virtualisation** in the fleet table, which is plain DOM and comfortable
  into the high hundreds of nodes.
- **Node detail renders every backend expanded** on each poll. Fine for a
  handful; on a node with dozens of backends, collapse healthy ones by default
  and auto-open only degraded ones.

### Not built yet

Deliberately out of scope for this version, in the order they make sense:

1. **Config editing** via Data Plane API transactions (diff → validate → commit
   → reload). This is also what unlocks weight changes: the runtime API exposes
   no weight field in either v2 or v3, so the capability is absent rather than
   broken — see [Known transport differences](#known-transport-differences).
2. **Alerting** on backend degradation. The fleet status indicator makes trouble
   visible while someone is looking; alerting is what covers the rest of the day.
3. **Routing chosen by Lua.** The service view is built from
   `default_backend` and backend switching rules, which covers the ways HAProxy
   config selects a backend. A backend chosen by a Lua action is invisible to
   both and appears under **Unrouted backends**.
4. **Service grouping for the stats-page driver.** It cannot read configuration,
   so those nodes fall back to flat frontend and backend lists. A Runtime API
   socket driver would close this and remove the Data Plane API dependency.
5. **SSO (OIDC)** instead of local accounts.
