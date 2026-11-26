import hmac
import secrets
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError

from . import llm
from .db import LOGIN_SECONDS, SESSION_SECONDS, Database
from .flow import decide
from .models import Branch, DecideRequest, Decision, Flow, Otherwise
from .oidc import Oidc, OidcError
from .settings import Settings

HERE = Path(__file__).parent
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; "
    "base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
}


class Throttle:
    """In-memory sliding window; enough for a single process."""

    def __init__(self, limit: int, seconds: int):
        self.limit, self.seconds = limit, seconds
        self.hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        if len(self.hits) > 10_000:
            self.hits.clear()
        q = self.hits[key]
        while q and now - q[0] > self.seconds:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True


class LoginRequired(Exception):
    pass


def create_app(
    settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None
) -> FastAPI:
    settings = settings or Settings()
    db = Database(settings.database_path)
    templates = Jinja2Templates(directory=HERE / "templates")
    app = FastAPI(title="Freight Auto-Reply", docs_url=None, redoc_url=None, openapi_url=None)
    app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
    login_throttle = Throttle(10, 15 * 60)
    api_throttle = Throttle(60, 60)
    oidc = Oidc(settings, transport)
    allowed_groups = {g.strip() for g in settings.oidc_allowed_groups.split(",") if g.strip()}

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.exception_handler(LoginRequired)
    async def to_login(request: Request, exc: LoginRequired):
        return RedirectResponse("/login", status_code=303)

    def client_ip(request: Request) -> str:
        # Only Caddy can reach the container, and it sets this header itself.
        return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")

    def current_user(request: Request):
        token = request.cookies.get("session")
        user = db.session(token) if token else None
        if not user:
            raise LoginRequired()
        return user

    async def checked_form(request: Request, user=Depends(current_user)):
        form = await request.form()
        if not hmac.compare_digest(str(form.get("csrf", "")), user["csrf"]):
            raise HTTPException(403, "invalid form token, reload the page")
        return user, form

    def dashboard(request: Request, user, status: int = 200, **extra):
        return templates.TemplateResponse(
            request,
            "dashboard.html",
            {
                "user": user,
                "flow": db.flow(user["id"]),
                "key": db.api_key(user["id"]),
                "llm_ready": bool(settings.llm_api_key),
                "llm_used": db.llm_calls_today(user["id"]),
                "llm_limit": settings.llm_daily_limit,
                "base_url": settings.base_url,
                **extra,
            },
            status_code=status,
        )

    async def run_flow(user, msg: DecideRequest, client: httpx.AsyncClient) -> Decision:
        async def ask(flow: Flow, instructions: str, m: DecideRequest):
            if not settings.llm_api_key:
                raise llm.LlmError("AI replies are not configured on the server")
            if not db.take_llm_call(user["id"], settings.llm_daily_limit):
                raise llm.LlmError("daily AI limit reached")
            return await llm.complete(client, settings, flow, instructions, m)

        return await decide(db.flow(user["id"]), msg, ask)

    # ---- API used by the browser extension

    def api_user(request: Request):
        scheme, _, key = request.headers.get("authorization", "").partition(" ")
        user = db.user_by_api_key(key) if scheme.lower() == "bearer" and key else None
        if not user:
            raise HTTPException(401, "invalid access key")
        if not api_throttle.allow(str(user["id"])):
            raise HTTPException(429, "too many requests")
        return user

    def payment_required():
        url = settings.payment_url or f"{settings.base_url}/billing"
        return JSONResponse({"paymentUrl": url}, status_code=402)

    @app.get("/healthz")
    def healthz():
        db.one("SELECT 1")
        return {"ok": True}

    @app.get("/v1/me")
    def me(user=Depends(api_user)):
        if not user["active"]:
            return payment_required()
        return {"email": user["email"], "aiConfigured": bool(settings.llm_api_key)}

    @app.post("/v1/decide")
    async def api_decide(msg: DecideRequest, user=Depends(api_user)):
        if not user["active"]:
            return payment_required()
        async with httpx.AsyncClient(transport=transport) as client:
            try:
                return await run_flow(user, msg, client)
            except llm.LlmError as e:
                return JSONResponse({"detail": str(e)}, status_code=503)

    # ---- Web UI

    def login_view(request: Request, error: str = "", status: int = 200):
        return templates.TemplateResponse(
            request,
            "login.html",
            {"error": error, "configured": bool(settings.oidc_client_id)},
            status_code=status,
        )

    def cookie_options() -> dict:
        return {"httponly": True, "samesite": "lax", "secure": settings.secure_cookies}

    @app.get("/login")
    def login_page(request: Request):
        return login_view(request)

    @app.get("/auth/login")
    async def sso_start(request: Request):
        if not settings.oidc_client_id:
            return login_view(request, "Single sign-on is not set up on the server yet.", 503)
        if not login_throttle.allow(client_ip(request)):
            return login_view(request, "Too many attempts. Try again in 15 minutes.", 429)
        state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
        try:
            url = await oidc.authorize_url(state, nonce, verifier)
        except OidcError as e:
            return login_view(request, f"Sign-in is unavailable: {e}", 502)
        db.start_login(state, verifier, nonce)
        response = RedirectResponse(url, status_code=303)
        # Ties the attempt to this browser, so nobody can be signed in with someone else's link.
        response.set_cookie("sso_state", state, max_age=LOGIN_SECONDS, path="/auth", **cookie_options())
        return response

    @app.get("/auth/callback")
    async def sso_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        def fail(message: str, status: int):
            response = login_view(request, message, status)
            response.delete_cookie("sso_state", path="/auth")
            return response

        cookie = request.cookies.get("sso_state", "")
        if not state or not hmac.compare_digest(cookie.encode(), state.encode()):
            return fail("That sign-in attempt expired or started in another browser. Try again.", 400)
        pending = db.take_login(state)
        if not pending:
            return fail("That sign-in attempt expired. Try again.", 400)
        if error or not code:
            return fail("Sign-in was cancelled or refused.", 403)
        try:
            claims = await oidc.sign_in(code, pending["verifier"], pending["nonce"])
        except OidcError as e:
            return fail(f"Sign-in failed: {e}", 502)
        groups = claims.get("groups")
        if not allowed_groups.intersection(groups if isinstance(groups, list) else []):
            return fail("Your account has no access to this app. Ask the administrator.", 403)
        email = str(claims.get("email") or claims.get("preferred_username") or claims["sub"])[:200]
        user_id = db.sign_in_user(str(claims["sub"])[:300], email)
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(
            "session", db.create_session(user_id), max_age=SESSION_SECONDS, **cookie_options()
        )
        response.delete_cookie("sso_state", path="/auth")
        return response

    @app.post("/logout")
    async def logout(data=Depends(checked_form)):
        db.run("DELETE FROM sessions WHERE hash = ?", data[0]["session_hash"])
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie("session")
        return response

    @app.get("/")
    def home(request: Request, saved: bool = False, user=Depends(current_user)):
        return dashboard(request, user, message="Saved." if saved else "")

    @app.post("/flow")
    async def save_flow(request: Request, data=Depends(checked_form)):
        """One form holds the whole flow; the pressed button says what else to do."""
        user, form = data
        op, _, target = str(form.get("op", "save")).partition(":")
        checkbox = lambda name: name in form  # noqa: E731
        text = lambda name, default="": str(form.get(name, default)).replace("\r\n", "\n").strip()  # noqa: E731
        try:
            branches = [
                Branch(
                    id=i,
                    name=text(f"{i}.name"),
                    enabled=checkbox(f"{i}.enabled"),
                    platform=text(f"{i}.platform", "any"),
                    first_only=checkbox(f"{i}.first_only"),
                    match=text(f"{i}.match", "keywords"),
                    keywords=text(f"{i}.keywords"),
                    action=text(f"{i}.action", "template"),
                    reply=text(f"{i}.reply"),
                    instructions=text(f"{i}.instructions"),
                    auto_send=text(f"{i}.send") == "auto",
                )
                for i in map(str, form.getlist("branch"))
            ]
            index = next((n for n, b in enumerate(branches) if b.id == target), None)
            if op == "add":
                branches.append(Branch(id=uuid.uuid4().hex[:12], name="New rule"))
            elif op == "remove" and index is not None:
                branches.pop(index)
            elif op in ("up", "down") and index is not None:
                other = index + (-1 if op == "up" else 1)
                if 0 <= other < len(branches):
                    branches[index], branches[other] = branches[other], branches[index]
            flow = Flow(
                branches=branches,
                otherwise=Otherwise(
                    action=text("otherwise.action", "none"),
                    reply=text("otherwise.reply"),
                    auto_send=text("otherwise.send") == "auto",
                ),
                prompt=text("prompt"),
                disclosure=text("disclosure"),
            )
        except ValidationError as e:
            first = e.errors()[0]
            where = ".".join(map(str, first["loc"]))
            return dashboard(request, user, status=422, error=f"Not saved. {where}: {first['msg']}")
        db.save_flow(user["id"], flow)
        return RedirectResponse("/?saved=true", status_code=303)

    @app.post("/test")
    async def try_message(request: Request, data=Depends(checked_form)):
        user, form = data
        try:
            msg = DecideRequest(
                platform=str(form.get("platform", "timocom")),
                text=str(form.get("text", "")),
                isFirst="is_first" in form,
            )
        except ValidationError:
            return dashboard(request, user, status=422, error="Type a message to test.")
        async with httpx.AsyncClient(transport=transport) as client:
            try:
                result, error = await run_flow(user, msg, client), ""
            except llm.LlmError as e:
                result, error = None, str(e)
        return dashboard(request, user, test_input=msg, test_result=result, test_error=error)

    @app.post("/api-key")
    async def new_api_key(request: Request, data=Depends(checked_form)):
        user, _ = data
        return dashboard(request, user, new_key=db.create_api_key(user["id"]))

    @app.get("/billing")
    def billing(request: Request, user=Depends(current_user)):
        return templates.TemplateResponse(
            request, "billing.html", {"user": user, "payment_url": settings.payment_url}
        )

    return app
