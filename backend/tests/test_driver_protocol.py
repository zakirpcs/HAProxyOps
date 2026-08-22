"""Every driver implements the whole driver protocol.

This exists because of a real regression: a span-based edit removed
`fetch_config` from the Data Plane driver, and nothing failed. Type checking
does not catch it - the protocol is structural and the drivers are built by a
factory - and no test called that method, so the Config page returned 500 in
production while the whole suite stayed green.
"""
import inspect

import pytest

from app.drivers.base import HAProxyDriver, UnsupportedOperation
from app.drivers.dataplane import DataPlaneDriver
from app.drivers.stats_csv import StatsCsvDriver

DRIVERS = [DataPlaneDriver, StatsCsvDriver]

PROTOCOL_METHODS = sorted(
    name for name, value in vars(HAProxyDriver).items()
    if callable(value) and not name.startswith("_")
)


def test_the_protocol_is_not_empty():
    # If this ever reads zero the rest of the file is vacuously true.
    assert len(PROTOCOL_METHODS) >= 5


@pytest.mark.parametrize("driver", DRIVERS, ids=lambda d: d.__name__)
def test_driver_implements_every_protocol_method(driver):
    missing = [m for m in PROTOCOL_METHODS if not hasattr(driver, m)]
    assert missing == [], f"{driver.__name__} is missing {missing}"


@pytest.mark.parametrize("driver", DRIVERS, ids=lambda d: d.__name__)
def test_protocol_methods_are_coroutines(driver):
    # A method that is not awaitable fails only when something calls it.
    for name in PROTOCOL_METHODS:
        method = getattr(driver, name)
        assert inspect.iscoroutinefunction(method), f"{driver.__name__}.{name} is not async"


@pytest.mark.asyncio
async def test_the_stats_driver_refuses_config_work_clearly():
    """It cannot serve configuration, and should say so rather than crash.

    The routers check the capability first, so this is defence in depth: if
    that check is ever bypassed the failure is a clear refusal, not an
    AttributeError surfacing as a 500.
    """
    driver = StatsCsvDriver.__new__(StatsCsvDriver)

    with pytest.raises(UnsupportedOperation):
        await driver.fetch_raw_config()
    with pytest.raises(UnsupportedOperation):
        await driver.push_raw_config("global\n", "1", validate_only=True)
