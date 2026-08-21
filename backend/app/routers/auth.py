from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from .. import ratelimit, revocation
from ..deps import CurrentUser, RequireAdmin, SessionDep
from ..models import Role, User
from ..schemas import LoginRequest, Token, UserCreate, UserOut
from ..security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=Token)
async def login(payload: LoginRequest, session: SessionDep, request: Request) -> Token:
    ip = ratelimit.client_ip(request)

    retry_after = await ratelimit.check(ip, payload.username)
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many failed sign-in attempts. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )

    user = await session.scalar(select(User).where(User.username == payload.username))
    if user is None or not verify_password(payload.password, user.password_hash):
        await ratelimit.record_failure(ip, payload.username)
        # Same message either way - do not reveal which usernames exist.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    if not user.is_active:
        # A disabled account is still a failed attempt worth counting: it is a
        # valid username, and unlimited guesses against it are still guesses.
        await ratelimit.record_failure(ip, payload.username)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account disabled")

    await ratelimit.clear(ip, payload.username)
    return Token(
        access_token=create_access_token(user.username, user.role),
        username=user.username,
        role=Role(user.role),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, _: CurrentUser) -> None:
    """Revoke the presented token.

    Signing out of a stateless token has to be recorded somewhere; without this
    a "signed out" session keeps working until its 12-hour expiry.
    """
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return
    payload = decode_access_token(header[7:])
    jti, exp = payload.get("jti"), payload.get("exp")
    if jti and exp:
        await revocation.revoke_token(jti, float(exp))


@router.post("/users/{username}/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_sessions(username: str, _: RequireAdmin) -> None:
    """End every session a user has, everywhere.

    The lever to pull when an account is compromised or someone leaves: it does
    not need the tokens enumerated, because they never were stored.
    """
    await revocation.revoke_all_for(username)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.get("/users", response_model=list[UserOut])
async def list_users(_: RequireAdmin, session: SessionDep) -> list[User]:
    return list((await session.scalars(select(User).order_by(User.username))).all())


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(payload: UserCreate, _: RequireAdmin, session: SessionDep) -> User:
    if await session.scalar(select(User).where(User.username == payload.username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already exists")
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user
