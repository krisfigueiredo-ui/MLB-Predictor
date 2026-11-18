from __future__ import annotations

import numpy as np


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def log_loss(p: np.ndarray, y: np.ndarray, eps: float = 1e-6) -> float:
    p = np.clip(p, eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    p, y = np.asarray(p, float), np.asarray(y, float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def reliability(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    p, y = np.asarray(p, float), np.asarray(y, float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    out = []
    for b in range(bins):
        m = idx == b
        if m.any():
            out.append(dict(bin_low=float(edges[b]), bin_high=float(edges[b + 1]), mean_pred=float(p[m].mean()),
                            observed=float(y[m].mean()), n=int(m.sum())))
    return out


def wilson_interval(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    ph = k / n
    d = 1 + z * z / n
    c = (ph + z * z / (2 * n)) / d
    h = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / d
    return (float(max(0, c - h)), float(min(1, c + h)))


def regression_metrics(pred: np.ndarray, y: np.ndarray) -> dict:
    e = np.asarray(pred) - np.asarray(y)
    return dict(mae=float(np.mean(np.abs(e))), rmse=float(np.sqrt(np.mean(e**2))), bias=float(np.mean(e)), n=int(len(e)))


def classification_metrics(p: np.ndarray, y: np.ndarray) -> dict:
    p, y = np.asarray(p, float), np.asarray(y, float)
    hits = int(((p >= 0.5) == (y == 1)).sum())
    lo, hi = wilson_interval(hits, len(y))
    return dict(brier=brier(p, y), log_loss=log_loss(p, y), ece=ece(p, y), hit_rate=hits / max(1, len(y)),
                hit_rate_ci=[lo, hi], n=int(len(y)))
