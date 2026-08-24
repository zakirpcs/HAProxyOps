"""Server weight changes: a configuration write, not a runtime one.

The Data Plane API has no runtime weight field in v2 or v3, so
set_server_weight reads the server's current configuration, edits the one
field, and writes the whole object back under the current config version.
"""
import pytest

from app.drivers.base import Capability, ConfigConflict, ConfigRejected, DriverError
from app.drivers.dataplane import DataPlaneDriver


class FakeNode:
    id = 1
    name = "lb-1"
    group = "edge"
    base_url = "http://node:5555"
    api_prefix = "/v3"
    username = "u"
    verify_tls = False
    driver = "dataplane"


class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text

    def json(self):
        return {"message": self.text}


class FakeClient:
    def __init__(self, put_response):
        self.put_response = put_response
        self.calls = []

    async def put(self, url, params=None, json=None):
        self.calls.append((url, params, json))
        return self.put_response


def build(prefix="/v3", current_server=None, put_response=None, version=7):
    driver = DataPlaneDriver.__new__(DataPlaneDriver)
    driver.node = FakeNode()
    driver.prefix = prefix
    driver.capabilities = (Capability.READ_STATE, Capability.SET_WEIGHT)

    current_server = current_server or {
        "name": "web1", "address": "10.0.0.1", "port": 80, "weight": 100,
    }

    async def _request(method, path, **kwargs):
        if path == "/configuration/version":
            return version
        return {"data": current_server}

    driver._request = _request
    driver._client = FakeClient(put_response or FakeResponse(200))
    return driver


@pytest.mark.asyncio
async def test_weight_change_reads_then_writes_the_full_server_object():
    driver = build(current_server={
        "name": "web1", "address": "10.0.0.1", "port": 80, "weight": 100,
    })
    await driver.set_server_weight("app-back", "web1", 50)

    url, params, body = driver._client.calls[0]
    assert url == "/v3/services/haproxy/configuration/backends/app-back/servers/web1"
    assert params["version"] == 7
    assert body["weight"] == 50
    # A full replace, not a partial patch - fields we did not touch must
    # still be present or the write would silently clear them.
    assert body["address"] == "10.0.0.1"


def test_v2_uses_the_query_parameter_form():
    driver = build(prefix="/v2")
    path, params = driver._config_server_path("app-back", "web1")
    assert path == "/configuration/servers/web1"
    assert params == {"backend": "app-back"}


def test_v3_nests_the_server_under_its_backend():
    driver = build(prefix="/v3")
    path, params = driver._config_server_path("app-back", "web1")
    assert path == "/configuration/backends/app-back/servers/web1"
    assert params == {}


@pytest.mark.asyncio
async def test_a_stale_version_is_a_conflict_not_a_generic_error():
    driver = build(put_response=FakeResponse(409, text="config changed"))
    with pytest.raises(ConfigConflict):
        await driver.set_server_weight("app-back", "web1", 50)


@pytest.mark.asyncio
async def test_an_invalid_weight_is_rejected_not_a_generic_error():
    driver = build(put_response=FakeResponse(400, text="weight must be between 0 and 256"))
    with pytest.raises(ConfigRejected):
        await driver.set_server_weight("app-back", "web1", 999)


@pytest.mark.asyncio
async def test_other_failures_stay_generic():
    driver = build(put_response=FakeResponse(500, text="boom"))
    with pytest.raises(DriverError):
        await driver.set_server_weight("app-back", "web1", 50)


@pytest.mark.asyncio
async def test_an_unreadable_current_config_refuses_clearly():
    driver = build()

    async def _request(method, path, **kwargs):
        return {"data": "not a dict"}

    driver._request = _request
    with pytest.raises(DriverError):
        await driver.set_server_weight("app-back", "web1", 50)
