from ..models import DriverKind, Node
from .base import Capability, HAProxyDriver
from .dataplane import DataPlaneDriver
from .stats_csv import StatsCsvDriver


def build_driver(node: Node, password: str | None = None, timeout: float = 5.0) -> HAProxyDriver:
    """Instantiate the transport driver configured for a node."""
    if node.driver == DriverKind.STATS_CSV:
        return StatsCsvDriver(node, password=password, timeout=timeout)
    return DataPlaneDriver(node, password=password, timeout=timeout)


__all__ = ["Capability", "DataPlaneDriver", "HAProxyDriver", "StatsCsvDriver", "build_driver"]
