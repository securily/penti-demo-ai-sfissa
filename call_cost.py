"""USD cost of one Northstar REPL LLM call from provider token usage.

List prices are per 1M tokens. Cursor Composer uses the published standard tier
when the SDK already priced the call. No Composer SDK lives in this repo.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

# USD / 1M tokens. Published or list-price estimates for this demo's model list.
PRICING_PER_M: Dict[str, Dict[str, float]] = {
    "gpt-5.6-luna": {"input": 0.40, "output": 1.60},
    "composer-2.5": {"input": 0.50, "output": 2.50},
    "kimi-k2.7-code": {"input": 1.00, "output": 5.00},
    "glm-5.2": {"input": 1.00, "output": 5.00},
    "gemini-3.7-flash": {"input": 0.30, "output": 2.50},
    "grok-4.6": {"input": 2.00, "output": 10.00},
    "kimi-k3": {"input": 3.00, "output": 15.00},
    "gpt-5.6-terra": {"input": 3.00, "output": 12.00},
    "claude-sonnet-5": {"input": 2.00, "output": 10.00},
}


def estimate_tokens(*texts: Any) -> int:
    n = sum(len(str(t or "")) for t in texts)
    return max(1, n // 4)


def cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    rates = PRICING_PER_M.get(model) or {"input": 1.0, "output": 5.0}
    pin = max(0, int(prompt_tokens or 0)) / 1_000_000.0
    pout = max(0, int(completion_tokens or 0)) / 1_000_000.0
    return pin * float(rates["input"]) + pout * float(rates["output"])


def pack_usage(provider: str, model: str, prompt_tokens: int, completion_tokens: int) -> Dict[str, Any]:
    pt = max(0, int(prompt_tokens or 0))
    ct = max(0, int(completion_tokens or 0))
    return {
        "provider": provider,
        "model": model,
        "prompt_tokens": pt,
        "completion_tokens": ct,
        "total_tokens": pt + ct,
        "estimated_cost": round(cost_usd(model, pt, ct), 6),
    }


def usage_openai(data: Dict[str, Any], model: str, system: str, user: str, text: str) -> Dict[str, Any]:
    raw = data.get("usage") or {}
    pt = int(raw.get("prompt_tokens") or 0) or estimate_tokens(system, user)
    ct = int(raw.get("completion_tokens") or 0) or estimate_tokens(text)
    return pack_usage("openai", model, pt, ct)


def usage_anthropic(data: Dict[str, Any], model: str, system: str, user: str, text: str) -> Dict[str, Any]:
    raw = data.get("usage") or {}
    pt = int(raw.get("input_tokens") or 0) or estimate_tokens(system, user)
    ct = int(raw.get("output_tokens") or 0) or estimate_tokens(text)
    return pack_usage("anthropic", model, pt, ct)


def usage_gemini(data: Dict[str, Any], model: str, system: str, user: str, text: str) -> Dict[str, Any]:
    raw = data.get("usageMetadata") or {}
    pt = int(raw.get("promptTokenCount") or 0) or estimate_tokens(system, user)
    ct = int(raw.get("candidatesTokenCount") or 0) or estimate_tokens(text)
    return pack_usage("gemini", model, pt, ct)


def usage_cursor(raw: Optional[Dict[str, Any]], model: str, system: str, user: str, text: str) -> Dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    pt = int(data.get("prompt_tokens") or 0) or estimate_tokens(system, user)
    ct = int(data.get("completion_tokens") or 0) or estimate_tokens(text)
    priced = float(data.get("estimated_cost") or 0)
    if priced <= 0:
        priced = cost_usd(model, pt, ct)
    out = pack_usage("cursor", model, pt, ct)
    out["estimated_cost"] = round(priced, 6)
    if data.get("cost_source"):
        out["cost_source"] = data.get("cost_source")
    return out
