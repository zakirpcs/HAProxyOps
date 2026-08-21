"""Shared FastAPI dependencies: current user, RBAC gates, audit writer."""
from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import AuditLog, Role, User
from .revocation import is_revoked
from .security import decode_access_token

bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]

_ROLE_RANK = {Role.VIEWER: 0, Role.OPERATOR: 1, Role.ADMIN: 2}


async def current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    session: SessionDep,
) -> User:
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expired") from None
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token") from None

    if await is_revoked(payload):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session ended") from None

    user = await session.scalar(select(User).where(User.username == payload.get("sub")))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer active")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_role(minimum: Role):
    """Gate an endpoint on a minimum role. viewer < operator < admin."""

    async def _guard(user: CurrentUser) -> User:
        if _ROLE_RANK.get(Role(user.role), -1) < _ROLE_RANK[minimum]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"Requires the '{minimum}' role or higher; you have '{user.role}'.",
            )
        return user

    return _guard


RequireOperator = Annotated[User, Depends(require_role(Role.OPERATOR))]
RequireAdmin = Annotated[User, Depends(require_role(Role.ADMIN))]


async def write_audit(
    session: AsyncSession,
    request: Request,
    user: User,
    action: str,
    *,
    node_name: str | None = None,
    target: str | None = None,
    detail: str | None = None,
    success: bool = True,
) -> None:
    session.add(
        AuditLog(
            username=user.username,
            action=action,
            node_name=node_name,
            target=target,
            detail=detail,
            success=success,
            source_ip=request.client.host if request.client else None,
        )
    )
    await session.commit()
