"""Notify someone when the fleet breaks, without becoming noise.

The status indicator in the dashboard only helps while somebody is looking at
it. This covers the other twenty-three hours.

The hard part of alerting is not detecting a problem; it is not crying wolf.
Three things do that work here:

* **Alerts fire on a transition, not on a state.** A backend that has been down
  for an hour is one alert, not one per poll cycle.
* **A problem must persist before it is worth a message.** ``ALERT_FOR_SECONDS``
  of continuous trouble, which a node restarting or a health check blipping
  will not survive.
* **Recovery is announced.** An alert that never resolves teaches people to
  ignore the channel, because they cannot tell live problems from old ones.

State lives in Redis so it survives a restart of the API: without that, a
redeploy would re-announce every problem the fleet already has.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import get_settings
from .state import get_redis

log = logging.getLogger("haproxyops")
settings = get_settings()

_KEY = "haproxyops:alert:"

#: How long a problem must persist before it is announced.
ALERT_FOR_SECONDS = 60.0
#: How long a firing alert waits before repeating itself. Zero disables repeats.
ALERT_REPEAT_SECONDS = 3600.0


@dataclass(slots=True)
class Alert:
    """One problem worth telling somebody about."""

    key: str
    severity: str  # "critical" | "warning"
    title: str
    detail: str
    node: str
    #: Extra fields passed through to the webhook payload untouched.
    labels: dict[str, Any] = field(default_factory=dict)


def evaluate(snapshots: list[dict]) -> list[Alert]:
    """Current problems across the fleet.

    Pure: takes snapshots, returns alerts, touches nothing. Everything about
    *when* to notify is handled separately, so the rules stay easy to read and
    to test.
    """
    alerts: list[Alert] = []

    for snapshot in snapshots:
        node = snapshot.get("node_name", "?")
        node_id = snapshot.get("node_id")

        if snapshot.get("enabled") is False:
            # Polling is off deliberately; silence is the point.
            continue

        if not snapshot.get("reachable"):
            alerts.append(Alert(
                key=f"node-down:{node_id}",
                severity="critical",
                title=f"{node} is unreachable",
                detail=snapshot.get("error") or "The dashboard cannot reach this node.",
                node=node,
                labels={"node_id": node_id, "kind": "node_down"},
            ))
            # Its backends cannot be judged from a snapshot that failed.
            continue

        for backend in snapshot.get("backends", []):
            active = [s for s in backend.get("servers", []) if not s.get("backup")]
            if not active:
                continue
            up = [s for s in active if s.get("is_up")]

            if not up:
                alerts.append(Alert(
                    key=f"backend-down:{node_id}:{backend['name']}",
                    severity="critical",
                    title=f"{node}/{backend['name']} has no active servers",
                    detail=(
                        f"All {len(active)} active servers are down. "
                        "Traffic to this backend is failing."
                    ),
                    node=node,
                    labels={"node_id": node_id, "backend": backend["name"],
                            "kind": "backend_down"},
                ))
            elif len(up) < len(active):
                alerts.append(Alert(
                    key=f"backend-degraded:{node_id}:{backend['name']}",
                    severity="warning",
                    title=f"{node}/{backend['name']} is degraded",
                    detail=(
                        f"{len(active) - len(up)} of {len(active)} active servers are "
                        f"down: {', '.join(s['name'] for s in active if not s.get('is_up'))}."
                    ),
                    node=node,
                    labels={"node_id": node_id, "backend": backend["name"],
                            "kind": "backend_degraded"},
                ))

    return alerts


@dataclass(slots=True)
class Decision:
    """What to send this cycle, having compared now against what was known."""

    firing: list[Alert] = field(default_factory=list)
    resolved: list[str] = field(default_factory=list)


def decide(
    current: list[Alert],
    known: dict[str, dict],
    now: float,
    for_seconds: float = ALERT_FOR_SECONDS,
    repeat_seconds: float = ALERT_REPEAT_SECONDS,
) -> tuple[Decision, dict[str, dict]]:
    """Fold this cycle's problems into what was already known.

    ``known`` maps an alert key to ``{"since": float, "notified": float | None}``.
    Returns what to send and the state to store back, so the caller owns all the
    I/O and this stays a pure function over time.
    """
    decision = Decision()
    next_state: dict[str, dict] = {}
    by_key = {a.key: a for a in current}

    for key, alert in by_key.items():
        entry = known.get(key)
        since = entry["since"] if entry else now
        notified = entry.get("notified") if entry else None

        if notified is None:
            # Only worth a message once it has lasted; a node restarting trips
            # every rule here for a few seconds and resolves itself.
            if now - since >= for_seconds:
                decision.firing.append(alert)
                notified = now
        elif repeat_seconds > 0 and now - notified >= repeat_seconds:
            decision.firing.append(alert)
            notified = now

        next_state[key] = {"since": since, "notified": notified}

    for key, entry in known.items():
        if key in by_key:
            continue
        # Only announce recovery for something that was actually announced;
        # a problem that never cleared the delay was never anyone's business.
        if entry.get("notified") is not None:
            decision.resolved.append(key)

    return decision, next_state


async def load_state() -> dict[str, dict]:
    try:
        raw = await get_redis().get(f"{_KEY}state")
        return json.loads(raw) if raw else {}
    except Exception:
        log.warning("could not read alert state; treating the fleet as new", exc_info=True)
        return {}


async def save_state(state: dict[str, dict]) -> None:
    try:
        await get_redis().set(f"{_KEY}state", json.dumps(state))
    except Exception:
        log.warning("could not persist alert state", exc_info=True)


def payload_for(alert: Alert, status: str) -> dict:
    """The webhook body. Deliberately flat and generic.

    Shaped to be readable by a human in Slack or Discord via an incoming-webhook
    bridge, and machine-parsable by anything else, without pretending to be
    Alertmanager's schema.
    """
    return {
        "status": status,  # "firing" | "resolved"
        "severity": alert.severity,
        "title": alert.title,
        "detail": alert.detail,
        "node": alert.node,
        "key": alert.key,
        "labels": alert.labels,
        "source": "haproxyops",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


async def deliver(payloads: list[dict], webhook_url: str | None) -> int:
    """POST each payload to the given webhook. Returns how many landed.

    Never raises: an alerting failure must not break the poll loop that feeds
    the dashboard. A webhook being down is worth a log line, not an outage of
    the thing people use to see the outage.
    """
    url = webhook_url
    if not url or not payloads:
        return 0

    sent = 0
    try:
        async with httpx.AsyncClient(timeout=settings.alert_timeout_seconds) as client:
            for payload in payloads:
                try:
                    response = await client.post(url, json=payload)
                    if response.status_code >= 400:
                        log.warning(
                            "alert webhook returned %s for %s",
                            response.status_code, payload.get("key"),
                        )
                        continue
                    sent += 1
                except httpx.HTTPError as exc:
                    log.warning("alert webhook failed for %s: %s", payload.get("key"), exc)
    except Exception:
        log.exception("alert delivery failed")
    return sent


async def run(snapshots: list[dict], webhook_url: str | None) -> Decision:
    """One alerting cycle: evaluate, decide, deliver, remember.

    webhook_url is resolved by the caller (settings_store.effective_alert_webhook_url) -
    it may come from the UI-editable setting or the HAPROXYOPS_ALERT_WEBHOOK_URL
    env var, and this module does not need to know which.
    """
    if not webhook_url:
        return Decision()

    known = await load_state()
    current = evaluate(snapshots)
    decision, next_state = decide(
        current, known, time.time(),
        settings.alert_for_seconds, settings.alert_repeat_seconds,
    )

    payloads = [payload_for(a, "firing") for a in decision.firing]
    # A resolution carries the key that fired, so a receiver can close its own
    # incident even though the alert object is gone.
    for key in decision.resolved:
        payloads.append({
            "status": "resolved", "key": key, "source": "haproxyops",
            "title": f"Resolved: {key}", "severity": "info", "detail": "",
            "node": known.get(key, {}).get("node", ""), "labels": {},
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

    if payloads:
        sent = await deliver(payloads, webhook_url)
        log.info(
            "alerts: %d firing, %d resolved, %d delivered",
            len(decision.firing), len(decision.resolved), sent,
        )

    await save_state(next_state)
    return decision
