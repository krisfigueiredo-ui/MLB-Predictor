"""Shared HTTP client: token-bucket rate limiting, retries with backoff, health records, caching."""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone

import httpx

from ..db import SessionLocal
from .. import models as m

log = logging.getLogger(__name__)


class RateLimiter:
    def __init__(self, per_minute: int):
        self.capacity = per_minute
        self.tokens = float(per_minute)
        self.rate = per_minute / 60.0
        self.ts = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
                self.ts = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
            time.sleep(0.25)


class Cache:
    """Redis when configured, otherwise in-process TTL dict."""

    def __init__(self, url: str | None):
        self._mem: dict[str, tuple[float, str]] = {}
        self._r = None
        if url:
            try:
                import redis

                self._r = redis.Redis.from_url(url, socket_timeout=1)
                self._r.ping()
            except Exception as exc:  # pragma: no cover
                log.warning("Redis unavailable (%s); using in-memory cache", exc)
                self._r = None

    @property
    def backend(self) -> str:
        return "redis" if self._r else "memory"

    def get(self, key: str):
        if self._r:
            v = self._r.get(key)
            return json.loads(v) if v else None
        hit = self._mem.get(key)
        if hit and hit[0] > time.time():
            return json.loads(hit[1])
        return None

    def set(self, key: str, value, ttl: int):
        s = json.dumps(value, default=str)
        if self._r:
            self._r.setex(key, ttl, s)
        else:
            self._mem[key] = (time.time() + ttl, s)


_cache: Cache | None = None


def cache() -> Cache:
    global _cache
    if _cache is None:
        from ..config import get_settings

        _cache = Cache(get_settings().redis_url)
    return _cache


class ProviderError(RuntimeError):
    pass


class Provider:
    name = "provider"
    base_url = ""
    per_minute = 30

    def __init__(self, api_key: str | None):
        self.api_key = api_key
        self.limiter = RateLimiter(self.per_minute)
        self.last_remaining: int | None = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def headers(self) -> dict:
        return {}

    def params(self) -> dict:
        return {}

    def get(self, path: str, params: dict | list | None = None, ttl: int = 30, retries: int = 3):
        if not self.configured:
            raise ProviderError(f"{self.name} is not configured (missing API key)")
        key = f"{self.name}:{path}:{json.dumps(params, sort_keys=True, default=str)}"
        hit = cache().get(key)
        if hit is not None:
            return hit
        merged = list((params or {}).items()) if isinstance(params, dict) else list(params or [])
        merged += list(self.params().items())
        err = None
        for attempt in range(retries + 1):
            self.limiter.acquire()
            t0 = time.monotonic()
            try:
                r = httpx.get(self.base_url + path, params=merged, headers=self.headers(), timeout=15)
                lat = (time.monotonic() - t0) * 1000
                rem = r.headers.get("x-requests-remaining") or r.headers.get("x-ratelimit-remaining")
                self.last_remaining = int(float(rem)) if rem else None
                if r.status_code == 429 or r.status_code >= 500:
                    err = ProviderError(f"{self.name} HTTP {r.status_code}")
                    time.sleep(min(30, 2 ** attempt + float(r.headers.get("retry-after", 0) or 0)))
                    continue
                if r.status_code >= 400:
                    self._health(False, lat, f"HTTP {r.status_code}: {r.text[:200]}")
                    raise ProviderError(f"{self.name} HTTP {r.status_code}: {r.text[:200]}")
                data = r.json()
                self._health(True, lat, "ok")
                cache().set(key, data, ttl)
                return data
            except httpx.HTTPError as exc:
                err = exc
                time.sleep(min(30, 2 ** attempt))
        self._health(False, None, str(err)[:300])
        raise ProviderError(f"{self.name} request failed: {err}")

    def _health(self, ok: bool, latency: float | None, msg: str):
        try:
            with SessionLocal() as db:
                db.add(m.ProviderHealth(provider=self.name, ok=ok, latency_ms=latency, message=msg,
                                        rate_limit_remaining=self.last_remaining, checked_at=datetime.now(timezone.utc)))
                db.commit()
        except Exception:  # pragma: no cover
            log.exception("could not record provider health")
