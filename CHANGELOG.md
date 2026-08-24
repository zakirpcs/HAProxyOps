# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Dates
are when a change landed on `main`, not when it shipped in a particular
deployment.

## Unreleased

### Added

- **Runtime weight changes.** The Data Plane API's `runtime_server` model has
  no weight field in either v2 or v3 (only `address` / `admin_state` /
  `operational_state` / `port`), so this was previously a hard 501 with no
  workaround. `DataPlaneDriver.set_server_weight` now reads the server's
  current configuration, edits `weight` in place, and writes the whole object
  back under the current config version - a configuration change, not a
  runtime one, and dataplaneapi's own `reload_strategy` picks it up the same
  way any other config write does. A `409` from a stale version surfaces as
  `ConfigConflict`, an invalid weight as `ConfigRejected`, both distinguished
  rather than collapsed into a generic failure.

  On the fleet view, a server's weight is now click-to-edit on any node whose
  driver advertises the `set_weight` capability (`stats_csv` nodes remain
  read-only, since they cannot write configuration at all). Verified live
  against production: changed a server's weight, confirmed it on both
  HAProxyOps's own polled snapshot and the node's own stats page, then
  reverted it.

  `backend/app/drivers/dataplane.py`, `backend/app/drivers/base.py`,
  `frontend/src/pages/NodeDetail.tsx`.
