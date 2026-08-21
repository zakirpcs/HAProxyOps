"""Keep credentials out of the access log.

EventSource cannot set request headers, so the SSE endpoint takes its JWT as a
query parameter. uvicorn logs the full request line, which means a valid token
- good for the whole of its lifetime - ends up in journald, `docker logs`, and
any log shipper pointed at them. The nginx site already drops query strings from
its own log; this does the same for the application's.
"""
import logging
import re

#: Query parameters whose values must never be logged.
SENSITIVE_PARAMS = ("token", "password", "secret", "api_key", "apikey")

_PATTERN = re.compile(
    r"(?i)\b(" + "|".join(SENSITIVE_PARAMS) + r")=([^&\s\"']*)"
)

REDACTED = r"\1=[REDACTED]"


def redact(text: str) -> str:
    return _PATTERN.sub(REDACTED, text)


class RedactSecrets(logging.Filter):
    """Rewrite sensitive query parameters in a log record before it is emitted.

    Both the formatted message and the positional args are scrubbed: uvicorn's
    access logger passes the request line as an arg and formats it later, so
    only touching ``record.msg`` would leave the token intact.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and "=" in record.msg:
            record.msg = redact(record.msg)
        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    k: redact(v) if isinstance(v, str) else v
                    for k, v in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    redact(a) if isinstance(a, str) else a for a in record.args
                )
        # Never drop the record - the request still deserves to be logged, just
        # without the credential in it.
        return True


def install() -> None:
    """Attach the filter to every logger that can carry a request line."""
    for name in ("uvicorn.access", "uvicorn.error", "httpx", "haproxyops", ""):
        logging.getLogger(name).addFilter(RedactSecrets())
