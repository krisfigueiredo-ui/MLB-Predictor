"""COURTSIDE AI loop with a fake Anthropic client (no network, no key)."""
from types import SimpleNamespace as NS


class FakeMessages:
    def __init__(self):
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        if len(self.calls) == 1:
            return NS(stop_reason="tool_use", model=kw["model"], content=[
                NS(type="text", text="Looking up the table."),
                NS(type="tool_use", id="tu_1", name="league_efficiency_table", input={"league": "CBB", "limit": 3}),
            ])
        # the tool result must be passed back as a user message containing tool_result blocks
        last = kw["messages"][-1]
        assert last["role"] == "user" and last["content"][0]["type"] == "tool_result"
        assert last["content"][0]["tool_use_id"] == "tu_1"
        return NS(stop_reason="end_turn", model=kw["model"], content=[NS(type="text", text="Texas leads in net rating [1].")])


def test_assistant_tool_loop(trained, db, monkeypatch):
    from app.ai import assistant

    fake = NS(beta=NS(messages=FakeMessages()))
    monkeypatch.setattr(assistant, "available", lambda: True)
    monkeypatch.setattr(assistant, "_client", lambda: fake)
    out = assistant.ask(db, "Which NCAA schools have the highest offensive efficiency?")
    assert out["answer"] == "Texas leads in net rating [1]."
    assert out["tool_calls"] == [{"tool": "league_efficiency_table", "input": {"league": "CBB", "limit": 3}, "ok": True}]
    assert out["citations"] and out["citations"][0]["n"] == 1
    first = fake.beta.messages.calls[0]
    assert first["model"] == "claude-opus-5-5"
    assert first["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in first["betas"]
    assert {t["name"] for t in first["tools"]} >= {"get_game_projection", "model_performance", "search_documents"}
    assert "Never estimate live scores" in first["system"]


def test_assistant_refusal_is_handled(trained, db, monkeypatch):
    from app.ai import assistant

    class Refuse:
        def create(self, **kw):
            return NS(stop_reason="refusal", model=kw["model"], content=[])

    monkeypatch.setattr(assistant, "available", lambda: True)
    monkeypatch.setattr(assistant, "_client", lambda: NS(beta=NS(messages=Refuse())))
    out = assistant.ask(db, "x")
    assert out["stop_reason"] == "refusal" and out["answer"]
