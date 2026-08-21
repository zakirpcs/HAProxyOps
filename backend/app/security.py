"""Password hashing, node-credential encryption, and JWT issue/verify."""
import base64
import hashlib
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from .config import get_settings

settings = get_settings()


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except ValueError:
        return False


def _fernet() -> Fernet:
    """Derive a stable Fernet key from the app secret.

    Rotating HAPROXYOPS_SECRET_KEY therefore invalidates stored node credentials;
    they must be re-entered. That is deliberate - the alternative is a second
    key to manage.
    """
    digest = hashlib.sha256(settings.secret_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "Stored node credential could not be decrypted - the secret key changed. "
            "Re-enter the node's password."
        ) from exc


def create_access_token(username: str, role: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": username,
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        # Identifies this token so signing out can revoke exactly it, rather
        # than every session the user has open elsewhere.
        "jti": uuid4().hex,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
