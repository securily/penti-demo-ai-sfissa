from call_cost import cost_usd, pack_usage, usage_openai


def test_luna_is_cheaper_than_terra_for_same_tokens():
    luna = cost_usd("gpt-5.6-luna", 2000, 400)
    terra = cost_usd("gpt-5.6-terra", 2000, 400)
    assert luna > 0
    assert terra > luna


def test_pack_usage_rounds_dollars():
    usage = pack_usage("openai", "gpt-5.6-luna", 2500, 500)
    assert usage["total_tokens"] == 3000
    assert usage["estimated_cost"] == cost_usd("gpt-5.6-luna", 2500, 500)
    assert usage["estimated_cost"] < 0.01


def test_openai_usage_reads_provider_tokens():
    usage = usage_openai(
        {"usage": {"prompt_tokens": 1200, "completion_tokens": 80}},
        "gpt-5.6-luna",
        "sys",
        "user",
        "ok",
    )
    assert usage["prompt_tokens"] == 1200
    assert usage["completion_tokens"] == 80
    assert usage["estimated_cost"] > 0
