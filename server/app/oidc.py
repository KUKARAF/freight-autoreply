"""Sign-in through an OpenID Connect provider (Authentik): authorization code + PKCE, public client."""

import base64
import hashlib
from urllib.parse import urlencode, urlsplit

import httpx
import jwt

from .settings import Settings

ALGORITHMS = ["RS256", "ES256"]  # never "none", never a shared-secret algorithm


class OidcError(Exception):
    pass


def challenge_for(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def _require_secure(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" and parts.hostname not in ("localhost", "127.0.0.1"):
        raise OidcError("the sign-in provider must use https")
    return url


class Oidc:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings, self.transport = settings, transport
        self._metadata: dict | None = None

    @property
    def redirect_uri(self) -> str:
        return f"{self.settings.base_url.rstrip('/')}/auth/callback"

    async def _fetch(self, method: str, url: str, **kwargs) -> dict:
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=15) as client:
                res = await client.request(method, _require_secure(url), **kwargs)
                res.raise_for_status()
                return res.json()
        except (httpx.HTTPError, ValueError) as e:
            raise OidcError(f"the sign-in provider did not answer correctly ({type(e).__name__})") from e

    async def metadata(self) -> dict:
        if self._metadata is None:
            issuer = self.settings.oidc_issuer.rstrip("/")
            data = await self._fetch("GET", f"{issuer}/.well-known/openid-configuration")
            if str(data.get("issuer", "")).rstrip("/") != issuer:
                raise OidcError("the sign-in provider reports a different issuer")
            self._metadata = data
        return self._metadata

    async def authorize_url(self, state: str, nonce: str, verifier: str) -> str:
        endpoint = _require_secure((await self.metadata())["authorization_endpoint"])
        query = {
            "response_type": "code",
            "client_id": self.settings.oidc_client_id,
            "redirect_uri": self.redirect_uri,
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge_for(verifier),
            "code_challenge_method": "S256",
        }
        return f"{endpoint}?{urlencode(query)}"

    async def sign_in(self, code: str, verifier: str, nonce: str) -> dict:
        """Exchange the code and return the verified ID token claims."""
        meta = await self.metadata()
        tokens = await self._fetch(
            "POST",
            meta["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "client_id": self.settings.oidc_client_id,
                "code_verifier": verifier,
            },
        )
        # Keys are fetched on every sign-in, so a rotated key needs no restart.
        keys = (await self._fetch("GET", meta["jwks_uri"])).get("keys", [])
        try:
            token = tokens["id_token"]
            kid = jwt.get_unverified_header(token).get("kid")
            key = next(k for k in keys if k.get("kid") == kid)
            claims = jwt.decode(
                token,
                jwt.PyJWK(key).key,
                algorithms=ALGORITHMS,
                audience=self.settings.oidc_client_id,
                issuer=meta["issuer"],
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
                leeway=30,
            )
        except (jwt.PyJWTError, KeyError, StopIteration) as e:
            raise OidcError("the sign-in token is not valid") from e
        if claims.get("nonce") != nonce:
            raise OidcError("the sign-in token belongs to another attempt")
        return claims
