import math

import pytest

from app.services import odds_math as om


def test_american_decimal_roundtrip():
    assert om.american_to_decimal(-110) == pytest.approx(1.909090, rel=1e-5)
    assert om.american_to_decimal(150) == pytest.approx(2.5)
    for p in (-250, -110, 100, 135, 400):
        assert om.decimal_to_american(om.american_to_decimal(p)) == p


def test_no_vig_sums_to_one_and_removes_overround():
    a, b = om.no_vig_two_way(-110, -110)
    assert a == pytest.approx(0.5) and b == pytest.approx(0.5)
    a, b = om.no_vig_two_way(-200, 170)
    assert a + b == pytest.approx(1.0)
    assert a < om.implied_prob(-200)
    pa, pb = om.no_vig_two_way(-200, 170, method="power")
    assert pa + pb == pytest.approx(1.0, abs=1e-6)
    assert om.overround(-110, -110) == pytest.approx(0.0476, abs=1e-3)


def test_expected_value_and_push():
    assert om.expected_value(0.5, 100) == pytest.approx(0.0)
    assert om.expected_value(0.55, -110) == pytest.approx(0.55 * (100 / 110) - 0.45)
    # a push returns the stake: EV only counts win and loss mass
    assert om.expected_value(0.45, 100, p_push=0.10) == pytest.approx(0.45 - 0.45)
    assert om.fair_american(0.5) == 100
    assert om.fair_american(1.2) is None


def test_settlement_rules():
    assert om.settle_spread(margin_for_side=5, line=-5.5) == "loss"
    assert om.settle_spread(5, -4.5) == "win"
    assert om.settle_spread(5, -5.0) == "push"
    assert om.settle_spread(-3, 3.5) == "win"
    assert om.settle_total(220, 219.5, "over") == "win"
    assert om.settle_total(220, 220, "under") == "push"
    assert om.settle_total(210, 219.5, "under") == "win"
    assert om.settle_moneyline(1) == "win" and om.settle_moneyline(-7) == "loss"


def test_profit_units():
    assert om.profit_units("win", -110) == pytest.approx(100 / 110)
    assert om.profit_units("loss", 250, stake=2) == -2
    assert om.profit_units("push", -110) == 0
    assert om.kelly_fraction(0.6, 100) == pytest.approx(0.2)
    assert not math.isnan(om.kelly_fraction(0.3, -300))
