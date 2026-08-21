"""Alert rules, and the part that keeps them from becoming noise."""

from app.alerting import Alert, decide, evaluate, payload_for


def server(name, up, backup=False):
    return {"name": name, "is_up": up, "backup": backup, "status": "UP" if up else "DOWN"}


def node(node_id=1, name="lb-1", reachable=True, backends=(), enabled=True, error=None):
    return {
        "node_id": node_id, "node_name": name, "reachable": reachable,
        "enabled": enabled, "error": error, "backends": list(backends),
    }


def backend(name, servers):
    return {"name": name, "servers": list(servers)}


# --- rules ------------------------------------------------------------------

def test_an_unreachable_node_is_critical():
    alerts = evaluate([node(reachable=False, error="connection refused")])
    assert len(alerts) == 1
    assert alerts[0].severity == "critical"
    assert "unreachable" in alerts[0].title
    assert "connection refused" in alerts[0].detail


def test_a_disabled_node_is_silent():
    # Polling is off on purpose; alerting on it would punish the operator for
    # having told us to stop looking.
    assert evaluate([node(enabled=False, reachable=False)]) == []


def test_backends_are_not_judged_from_a_failed_snapshot():
    # An unreachable node reports no backends; inventing outages from that
    # would turn one problem into a dozen.
    alerts = evaluate([node(reachable=False, backends=[backend("app", [server("a", False)])])])
    assert [a.labels["kind"] for a in alerts] == ["node_down"]


def test_a_backend_with_nothing_up_is_critical():
    alerts = evaluate([node(backends=[backend("app", [server("a", False), server("b", False)])])])
    assert [a.severity for a in alerts] == ["critical"]
    assert "no active servers" in alerts[0].title


def test_a_partly_down_backend_is_a_warning_naming_the_servers():
    alerts = evaluate([node(backends=[backend("app", [server("a", True), server("b", False)])])])
    assert alerts[0].severity == "warning"
    assert "b" in alerts[0].detail


def test_a_healthy_fleet_produces_nothing():
    assert evaluate([node(backends=[backend("app", [server("a", True)])])]) == []


def test_a_down_backup_is_not_an_alert():
    # A standby is meant to be down. Alerting on it would page somebody nightly
    # for a system behaving exactly as designed.
    alerts = evaluate([node(backends=[backend("app", [server("a", True), server("s", False, backup=True)])])])
    assert alerts == []


def test_a_backend_of_only_backups_is_not_judged():
    alerts = evaluate([node(backends=[backend("app", [server("s", False, backup=True)])])])
    assert alerts == []


# --- when to speak ----------------------------------------------------------

ALERT = Alert(key="k", severity="critical", title="t", detail="d", node="n")


def test_a_brand_new_problem_waits_before_firing():
    decision, state = decide([ALERT], {}, now=1000.0, for_seconds=60)
    assert decision.firing == []
    # Remembered, so the clock starts now rather than on the next cycle.
    assert state["k"]["since"] == 1000.0


def test_it_fires_once_the_problem_has_lasted():
    _, state = decide([ALERT], {}, now=1000.0, for_seconds=60)
    decision, state = decide([ALERT], state, now=1061.0, for_seconds=60)
    assert [a.key for a in decision.firing] == ["k"]


def test_it_does_not_fire_again_every_cycle():
    _, state = decide([ALERT], {}, now=1000.0, for_seconds=60)
    _, state = decide([ALERT], state, now=1061.0, for_seconds=60)
    decision, _ = decide([ALERT], state, now=1070.0, for_seconds=60, repeat_seconds=3600)
    # The whole point: an hour-old outage is one message, not one per poll.
    assert decision.firing == []


def test_a_long_outage_repeats_on_the_configured_interval():
    _, state = decide([ALERT], {}, now=0.0, for_seconds=60)
    _, state = decide([ALERT], state, now=61.0, for_seconds=60)
    decision, _ = decide([ALERT], state, now=61.0 + 3600, for_seconds=60, repeat_seconds=3600)
    assert [a.key for a in decision.firing] == ["k"]


def test_repeats_can_be_switched_off():
    _, state = decide([ALERT], {}, now=0.0, for_seconds=60)
    _, state = decide([ALERT], state, now=61.0, for_seconds=60)
    decision, _ = decide([ALERT], state, now=1e9, for_seconds=60, repeat_seconds=0)
    assert decision.firing == []


def test_recovery_is_announced():
    _, state = decide([ALERT], {}, now=0.0, for_seconds=60)
    _, state = decide([ALERT], state, now=61.0, for_seconds=60)
    decision, state = decide([], state, now=120.0, for_seconds=60)
    assert decision.resolved == ["k"]
    # And forgotten, so it cannot resolve twice.
    assert state == {}


def test_a_flap_that_never_fired_never_resolves():
    # Fires nothing, so there is nothing to take back. Without this, a node
    # blipping for two seconds sends a resolution for an alert nobody saw.
    _, state = decide([ALERT], {}, now=0.0, for_seconds=60)
    decision, _ = decide([], state, now=10.0, for_seconds=60)
    assert decision.firing == [] and decision.resolved == []


def test_state_survives_a_restart_without_re_announcing():
    # load_state returns what was stored; a restart mid-outage must not
    # re-announce every problem the fleet already has.
    _, state = decide([ALERT], {}, now=0.0, for_seconds=60)
    _, state = decide([ALERT], state, now=61.0, for_seconds=60)
    decision, _ = decide([ALERT], dict(state), now=70.0, for_seconds=60, repeat_seconds=3600)
    assert decision.firing == []


# --- payload ----------------------------------------------------------------

def test_the_payload_carries_what_a_receiver_needs():
    body = payload_for(ALERT, "firing")
    assert body["status"] == "firing"
    assert body["severity"] == "critical"
    assert body["key"] == "k"
    assert body["source"] == "haproxyops"
    assert body["at"].endswith("Z")
