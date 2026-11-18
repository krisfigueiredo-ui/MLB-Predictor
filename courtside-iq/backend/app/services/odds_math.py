"""Sportsbook pricing math: implied probability, vig removal, fair odds, EV, settlement."""
from __future__ import annotations

import math


def american_to_decimal(price: int) -> float:
    if price == 0:
        raise ValueError("American price cannot be 0")
    return 1 + (price / 100 if price > 0 else 100 / -price)


def decimal_to_american(dec: float) -> int:
    if dec <= 1:
        raise ValueError("decimal odds must be > 1")
    return round((dec - 1) * 100) if dec >= 2 else round(-100 / (dec - 1))


def implied_prob(price: int) -> float:
    """Bookmaker-implied probability (includes vig)."""
    return 1 / american_to_decimal(price)


def no_vig_two_way(price_a: int, price_b: int, method: str = "multiplicative") -> tuple[float, float]:
    """Remove the overround from a two-way market.

    multiplicative: normalise implied probabilities (standard).
    power: find k with p_a^k + p_b^k = 1 (handles favourite-longshot bias better).
    """
    pa, pb = implied_prob(price_a), implied_prob(price_b)
    if method == "power":
        lo, hi = 0.5, 3.0
        for _ in range(80):
            k = (lo + hi) / 2
            s = pa**k + pb**k
            if s > 1:
                lo = k
            else:
                hi = k
        k = (lo + hi) / 2
        return pa**k, pb**k
    s = pa + pb
    return pa / s, pb / s


def overround(price_a: int, price_b: int) -> float:
    return implied_prob(price_a) + implied_prob(price_b) - 1


def fair_american(prob: float) -> int | None:
    if not 0 < prob < 1:
        return None
    return decimal_to_american(1 / prob)


def expected_value(p_win: float, price: int, p_push: float = 0.0) -> float:
    """EV per 1 unit staked. Pushes return the stake (0 profit)."""
    dec = american_to_decimal(price)
    p_loss = max(0.0, 1 - p_win - p_push)
    return p_win * (dec - 1) - p_loss


def kelly_fraction(p_win: float, price: int, p_push: float = 0.0) -> float:
    b = american_to_decimal(price) - 1
    p_loss = max(0.0, 1 - p_win - p_push)
    f = (b * p_win - p_loss) / b
    return max(0.0, f)


def profit_units(result: str, price: int | None, stake: float = 1.0) -> float:
    if price is None or result in ("push", "void", "pending"):
        return 0.0
    if result == "win":
        return stake * (american_to_decimal(price) - 1)
    if result == "loss":
        return -stake
    return 0.0


# ---------- settlement rules ----------

def settle_spread(margin_for_side: float, line: float) -> str:
    """margin_for_side = points scored by side - opponent; line is that side's spread (e.g. -5.5)."""
    adj = margin_for_side + line
    if math.isclose(adj, 0.0, abs_tol=1e-9):
        return "push"
    return "win" if adj > 0 else "loss"


def settle_total(actual_total: float, line: float, side: str) -> str:
    if math.isclose(actual_total, line, abs_tol=1e-9):
        return "push"
    over = actual_total > line
    return "win" if (over if side == "over" else not over) else "loss"


def settle_moneyline(margin_for_side: float) -> str:
    # Basketball moneylines include overtime; ties are not possible in a completed game.
    if margin_for_side == 0:
        return "void"
    return "win" if margin_for_side > 0 else "loss"
