"""Auto-revert: putting a held server back, and knowing when not to."""
from datetime import UTC, datetime, timedelta

import pytest

from app.maintenance import observed_state, still_held


def snap(reachable=True, servers=(("app", "web1", "DRAIN"),)):
    backends = {}
    for backend, server, status in servers:
        backends.setdefault(backend, []).append({"name": server, "status": status})
    return {
        "node_id": 1, "reachable": reachable,
        "backends": [{"name": b, "servers": s} for b, s in backends.items()],
    }


# --- reading reality --------------------------------------------------------

def test_it_finds_a_server_in_the_snapshot():
    assert observed_state(snap(), "app", "web1") == "DRAIN"


def test_a_server_that_is_gone_reads_as_none():
    # Removed from the config, or the node could not be reached.
    assert observed_state(snap(), "app", "vanished") is None
    assert observed_state(snap(), "other", "web1") is None


def test_it_does_not_confuse_backends_that_share_a_server_name():
    two = snap(servers=(("app", "web1", "DRAIN"), ("api", "web1", "UP")))
    assert observed_state(two, "app", "web1") == "DRAIN"
    assert observed_state(two, "api", "web1") == "UP"


# --- deciding whether the hold still applies --------------------------------

def test_a_server_still_in_its_held_state_is_still_held():
    assert still_held("DRAIN", "drain") is True
    assert still_held("MAINT", "maint") is True


def test_haproxy_status_suffixes_do_not_break_the_match():
    # HAProxy reports things like "MAINT (via app/web1)".
    assert still_held("MAINT (via app/web2)", "maint") is True


def test_a_server_someone_changed_is_no_longer_held():
    # Their decision is newer than the hold; overriding it would be worse than
    # leaving the server alone.
    assert still_held("UP", "drain") is False
    assert still_held("MAINT", "drain") is False


def test_a_server_that_is_gone_is_not_held():
    assert still_held(None, "drain") is False


# --- the sweep --------------------------------------------------------------

@pytest.mark.asyncio
async def test_expired_holds_are_selected_and_active_ones_are_not(db_session):
    from app.maintenance import due_holds
    from app.models import MaintenanceHold, Node

    node = Node(name="lb-1", base_url="http://x:5555", driver="dataplane", api_prefix="/v3")
    db_session.add(node)
    await db_session.flush()

    now = datetime.now(UTC)
    past = MaintenanceHold(node_id=node.id, backend="app", server="a", state="drain",
                           expires_at=now - timedelta(minutes=1), created_by="u")
    future = MaintenanceHold(node_id=node.id, backend="app", server="b", state="drain",
                             expires_at=now + timedelta(hours=1), created_by="u")
    released = MaintenanceHold(node_id=node.id, backend="app", server="c", state="drain",
                               expires_at=now - timedelta(hours=1), created_by="u",
                               released_at=now, release_reason="cancelled")
    db_session.add_all([past, future, released])
    await db_session.flush()

    due = await due_holds(db_session, now)
    assert [h.server for h in due] == ["a"]


@pytest.mark.asyncio
async def test_a_hold_on_an_unreachable_node_is_kept_for_the_next_cycle(db_session):
    from app.maintenance import sweep
    from app.models import MaintenanceHold, Node

    node = Node(name="lb-1", base_url="http://x:5555", driver="dataplane", api_prefix="/v3")
    db_session.add(node)
    await db_session.flush()
    hold = MaintenanceHold(node_id=node.id, backend="app", server="a", state="drain",
                           expires_at=datetime.now(UTC) - timedelta(minutes=1), created_by="u")
    db_session.add(hold)
    await db_session.flush()

    acted = await sweep(db_session, {node.id: snap(reachable=False)}, timeout=1.0)

    # Dropping it here is how a server stays drained forever.
    assert acted == 0
    assert hold.released_at is None


@pytest.mark.asyncio
async def test_a_hold_is_abandoned_when_someone_changed_the_server(db_session):
    from app.maintenance import sweep
    from app.models import MaintenanceHold, Node

    node = Node(name="lb-1", base_url="http://x:5555", driver="dataplane", api_prefix="/v3")
    db_session.add(node)
    await db_session.flush()
    hold = MaintenanceHold(node_id=node.id, backend="app", server="web1", state="drain",
                           expires_at=datetime.now(UTC) - timedelta(minutes=1), created_by="u")
    db_session.add(hold)
    await db_session.flush()

    # The operator set it to MAINT after the hold was created.
    acted = await sweep(
        db_session, {node.id: snap(servers=(("app", "web1", "MAINT"),))}, timeout=1.0)

    assert acted == 0
    assert hold.release_reason == "superseded"


@pytest.mark.asyncio
async def test_a_hold_for_a_server_that_no_longer_exists_is_closed(db_session):
    from app.maintenance import sweep
    from app.models import MaintenanceHold, Node

    node = Node(name="lb-1", base_url="http://x:5555", driver="dataplane", api_prefix="/v3")
    db_session.add(node)
    await db_session.flush()
    hold = MaintenanceHold(node_id=node.id, backend="app", server="gone", state="drain",
                           expires_at=datetime.now(UTC) - timedelta(minutes=1), created_by="u")
    db_session.add(hold)
    await db_session.flush()

    await sweep(db_session, {node.id: snap()}, timeout=1.0)
    assert hold.release_reason == "superseded"
