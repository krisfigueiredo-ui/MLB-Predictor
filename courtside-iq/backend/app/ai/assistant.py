"""COURTSIDE AI — Claude research assistant over verified database records.

Claude interprets; the Python models compute. The assistant runs a Messages API tool-use
loop on our own read-only tools (they query this application's database, so the loop is
hosted here rather than in a managed sandbox). Each answer returns the tool calls made and
the database citations gathered from them.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from ..config import get_settings
from . import tools

log = logging.getLogger(__name__)

SYSTEM = """You are COURTSIDE AI, the research analyst inside the COURTSIDE IQ basketball analytics platform.

Ground rules:
- Every number you state (scores, statistics, odds, probabilities, model outputs, accuracy) must come from a tool result in this conversation. If no tool returned it, say you don't have it. Never estimate live scores, odds or player stats yourself.
- Probabilities and projections are computed by the platform's Python models. Your job is to retrieve and explain them: what drives them (SHAP drivers, features), how they compare to the market, and how uncertain they are (intervals, sample sizes, calibration).
- When results are flagged is_demo or the model's data_source is synthetic_demo, say clearly that the figures come from synthetic demo data, not real games or real sportsbooks.
- Mention model versions and data timestamps when you cite projections. Be explicit about sample sizes; treat short streaks as descriptive, not predictive.
- Never present a forecast as a guarantee or encourage wagering. No financial advice.
- Be concise and well structured (short paragraphs or bullet points, small tables when comparing). Reference sources inline as [n] matching the order of the citations you relied on."""

MAX_TURNS = 8


def available() -> bool:
    return bool(get_settings().anthropic_api_key)


def _client():
    import anthropic

    return anthropic.Anthropic(api_key=get_settings().anthropic_api_key)


def ask(db: Session, question: str, history: list[dict] | None = None, context: dict | None = None) -> dict:
    if not available():
        return dict(answer=None, error="ANTHROPIC_API_KEY is not configured. COURTSIDE AI is disabled; the rest of the platform works normally.",
                    citations=[], tool_calls=[])
    import anthropic

    s = get_settings()
    client = _client()
    now = datetime.now(timezone.utc).isoformat(timespec="minutes")
    messages: list[dict] = []
    for h in (history or [])[-10:]:
        if h.get("role") in ("user", "assistant") and isinstance(h.get("content"), str):
            messages.append(dict(role=h["role"], content=h["content"]))
    ctx = f"\n\n(Current UTC time: {now}." + (f" User is viewing: {json.dumps(context)}" if context else "") + ")"
    messages.append(dict(role="user", content=question + ctx))
    citations: list[dict] = []
    calls: list[dict] = []
    tool_defs = tools.TOOLS
    response = None
    for _ in range(MAX_TURNS):
        try:
            response = client.beta.messages.create(
                model=s.anthropic_model, max_tokens=16000, system=SYSTEM, tools=tool_defs, messages=messages,
                output_config={"effort": s.ai_effort}, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            )
        except anthropic.AuthenticationError:
            return dict(answer=None, error="Anthropic API key was rejected.", citations=citations, tool_calls=calls)
        except anthropic.RateLimitError:
            return dict(answer=None, error="Anthropic rate limit reached; try again shortly.", citations=citations, tool_calls=calls)
        except anthropic.APIStatusError as exc:
            log.warning("Claude API error %s", exc.status_code)
            return dict(answer=None, error=f"Claude API error {exc.status_code}.", citations=citations, tool_calls=calls)
        except anthropic.APIConnectionError:
            return dict(answer=None, error="Could not reach the Anthropic API.", citations=citations, tool_calls=calls)
        if response.stop_reason == "refusal":
            return dict(answer="I can't help with that request.", citations=citations, tool_calls=calls, stop_reason="refusal")
        if response.stop_reason == "pause_turn":
            messages.append(dict(role="assistant", content=response.content))
            continue
        uses = [b for b in response.content if b.type == "tool_use"]
        if response.stop_reason != "tool_use" or not uses:
            break
        messages.append(dict(role="assistant", content=response.content))
        results = []
        for u in uses:
            args = u.input if isinstance(u.input, dict) else {}
            out = tools.run(db, u.name, args)
            cites = out.pop("citations", []) if isinstance(out, dict) else []
            for c in cites:
                c["n"] = len(citations) + 1
                citations.append(c)
            calls.append(dict(tool=u.name, input=args, ok="error" not in out))
            payload = json.dumps(dict(result=out, citation_numbers=[c["n"] for c in cites]), default=str)[:60000]
            results.append(dict(type="tool_result", tool_use_id=u.id, content=payload, is_error="error" in out))
        messages.append(dict(role="user", content=results))
    text = "".join(b.text for b in (response.content if response else []) if b.type == "text")
    return dict(answer=text, citations=citations, tool_calls=calls, model=getattr(response, "model", s.anthropic_model),
                stop_reason=getattr(response, "stop_reason", None), generated_at=now)
