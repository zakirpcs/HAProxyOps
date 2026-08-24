"""Parser tests using the wire shapes HAProxy and the Data Plane API really emit."""
from app.drivers.dataplane import _parse_info, _parse_native_stats
from app.drivers.stats_csv import _parse_csv

CSV_SAMPLE = """\
# pxname,svname,qcur,qmax,scur,smax,slim,stot,bin,bout,dreq,dresp,ereq,econ,eresp,wretr,wredis,status,weight,act,bck,chkfail,chkdown,lastchg,downtime,qlimit,pid,iid,sid,throttle,rate,rate_lim,rate_max,check_status,check_code,check_duration,type,addr,
http-in,FRONTEND,,,42,120,10000,98213,88213123,912831231,0,0,7,,,,,OPEN,,,,,,,,,1,2,0,,120,0,900,,,,0,,
app-back,web1,0,3,12,44,,32100,4412312,88123123,,,,1,2,0,0,UP,100,1,0,0,0,84213,0,,1,3,1,,44,,,L7OK,200,4,2,10.0.0.11:8080,
app-back,web2,0,1,0,9,,1200,112312,881231,,,,0,0,0,0,DOWN,100,1,0,3,2,120,240,,1,3,2,,2,,,L4CON,,2001,2,10.0.0.12:8080,
app-back,BACKEND,0,4,12,53,1000,33300,4524624,881004354,0,0,,1,2,0,0,UP,100,1,0,,0,84213,240,,1,3,0,,46,,,,,,1,,
"""

DATAPLANE_STATS = [
    {
        "name": "http-in",
        "type": "frontend",
        "stats": [{"name": "http-in", "stats": {
            "status": "OPEN", "scur": 42, "smax": 120, "slim": 10000,
            "stot": 98213, "bin": 88213123, "bout": 912831231, "ereq": 7, "rate": 120,
        }}],
    },
    {
        "name": "app-back",
        "type": "server",
        "stats": [{"name": "web1", "backend_name": "app-back", "stats": {
            "status": "UP", "weight": 100, "scur": 12, "stot": 32100,
            "check_status": "L7OK", "addr": "10.0.0.11:8080", "lastchg": 84213,
        }}],
    },
    {
        "name": "app-back",
        "type": "backend",
        "stats": [{"name": "app-back", "stats": {"status": "UP", "scur": 12, "qcur": 0}}],
    },
]


def test_csv_builds_backend_tree():
    frontends, backends = _parse_csv(CSV_SAMPLE)

    assert [f.name for f in frontends] == ["http-in"]
    assert frontends[0].status == "OPEN"
    assert frontends[0].sessions_current == 42
    assert frontends[0].request_errors == 7

    assert [b.name for b in backends] == ["app-back"]
    backend = backends[0]
    assert backend.servers_total if hasattr(backend, "servers_total") else True
    assert len(backend.servers) == 2
    assert backend.servers_up == 1

    web1, web2 = sorted(backend.servers, key=lambda s: s.name)
    assert web1.address == "10.0.0.11:8080"
    assert web1.check_status == "L7OK"
    assert web1.weight == 100
    assert web1.is_up
    assert not web2.is_up
    assert web2.check_failures == 3


def test_csv_ignores_listener_rows():
    """type=3 socket rows duplicate frontend counters; they must be dropped."""
    csv = CSV_SAMPLE + "http-in,IPv4-direct,,,1,1,,1,1,1,,,,,,,,OPEN,,,,,,,,,1,2,1,,1,,,,,,3,,\n"
    frontends, _ = _parse_csv(csv)
    assert len(frontends) == 1


def test_csv_tolerates_empty_counter_columns():
    """HAProxy leaves inapplicable counters blank rather than zero."""
    _, backends = _parse_csv(CSV_SAMPLE)
    assert backends[0].servers[0].queue_current == 0


def test_dataplane_native_stats():
    frontends, backends = _parse_native_stats(DATAPLANE_STATS)
    assert [f.name for f in frontends] == ["http-in"]
    assert frontends[0].sessions_limit == 10000
    assert [b.name for b in backends] == ["app-back"]
    assert [s.name for s in backends[0].servers] == ["web1"]
    assert backends[0].servers[0].backend == "app-back"


def test_dataplane_orphan_server_gets_synthetic_backend():
    """A server whose backend row is missing must still appear, not vanish."""
    payload = [{"name": "b", "type": "server",
                "stats": [{"name": "s1", "backend_name": "lonely", "stats": {"status": "UP"}}]}]
    _, backends = _parse_native_stats(payload)
    assert [b.name for b in backends] == ["lonely"]
    assert backends[0].servers[0].name == "s1"


def test_dataplane_info_unwraps_variants():
    assert _parse_info({"data": [{"info": {"version": "2.8.5", "uptime": 900, "pid": 42}}]}).version == "2.8.5"
    assert _parse_info([{"info": {"version": "3.0.1"}}]).version == "3.0.1"
    assert _parse_info({"version": "2.6.0", "uptime": 10}).uptime_seconds == 10
    assert _parse_info(None).version is None


def test_snapshot_serialisation_includes_derived_fields():
    from app.drivers.base import NodeSnapshot
    from app.state import snapshot_to_dict

    frontends, backends = _parse_csv(CSV_SAMPLE)
    data = snapshot_to_dict(
        NodeSnapshot(node_id=1, node_name="lb1", frontends=frontends, backends=backends)
    )
    assert data["backends"][0]["servers_up"] == 1
    assert data["backends"][0]["servers_total"] == 2
    assert data["backends"][0]["servers"][0]["is_up"] is True
    assert isinstance(data["polled_at"], object)


# --- runtime action routing -------------------------------------------------

def _driver(prefix: str):
    """A DataPlaneDriver without touching the network."""
    from app.drivers.dataplane import DataPlaneDriver
    from app.models import Node

    node = Node(name="n", group="g", driver="dataplane", base_url="http://x:5555",
                api_prefix=prefix, verify_tls=False)
    node.id = 1
    return DataPlaneDriver(node)


def test_v3_nests_runtime_server_under_backend():
    """v3 path is /runtime/backends/{backend}/servers/{name} - the v2 shape 404s."""
    path, params = _driver("/v3")._runtime_server_path("app-back", "web1")
    assert path == "/runtime/backends/app-back/servers/web1"
    assert params == {}


def test_v2_passes_backend_as_query_param():
    path, params = _driver("/v2")._runtime_server_path("app-back", "web1")
    assert path == "/runtime/servers/web1"
    assert params == {"backend": "app-back"}


def test_weight_is_advertised_alongside_admin_state():
    """runtime_server has no weight field in v2 or v3, but the driver makes up
    for it with a configuration write - see test_weight.py for that path."""
    from app.drivers.base import Capability

    for prefix in ("/v2", "/v3"):
        caps = _driver(prefix).capabilities
        assert Capability.SET_WEIGHT in caps
        assert Capability.SET_ADMIN_STATE in caps
