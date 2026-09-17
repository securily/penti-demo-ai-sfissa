"""Sandbox must not leak provider keys into Print stdout."""

from __future__ import annotations

import server


def test_max_turns_allows_write_then_exit():
    assert server.MAX_TURNS >= 4


def test_sandbox_env_strips_provider_keys(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-gemini")
    monkeypatch.setenv("OPENAI_API_KEY", "secret-openai")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret-anthropic")
    monkeypatch.setenv("GOOGLE_API_KEY", "secret-google")
    env = server._sandbox_env()
    assert "GEMINI_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert "ANTHROPIC_API_KEY" not in env
    assert "GOOGLE_API_KEY" not in env


def test_validate_blocks_dotenv():
    for cmd in (
        "cat .env",
        "cat '.env'",
        'cat ".env"',
        "head .env.example",
        "python3 -c \"print(open('.env').read())\"",
    ):
        ok, err = server.validate_command(cmd)
        assert ok is False, cmd
        assert "env" in err.lower()


def test_execute_echo_does_not_print_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "secret-should-not-leak")
    stdout, stderr, code = server.execute_command("python3 -c 'import os; print(os.getenv(\"GEMINI_API_KEY\") or \"none\")'")
    assert code == 0
    assert "secret-should-not-leak" not in stdout
    assert "none" in stdout


def test_validate_blocks_unquoted_shell_chaining():
    for cmd in (
        "cat scan/zap-report.json; cat .env",
        "cat scan/zap-report.json | cat",
        "echo hi && cat app/login.py",
        "echo hi || cat app/login.py",
        "echo hi &",
    ):
        ok, err = server.validate_command(cmd)
        assert ok is False, cmd
        assert "chaining" in err.lower()


def test_prompt_write_example_writes_csp(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    monkeypatch.setattr(server, "FIX", tmp_path / "fix")
    server.FIX.mkdir()
    cmd = (
        "python3 -c \"open('fix/csp.py','w').write('CSP = '+chr(34)+'default-src '"
        "+chr(39)+'self'+chr(39)+chr(34)+chr(10)+'# sets response header "
        "Content-Security-Policy to that value'+chr(10))\""
    )
    ok, err = server.validate_command(cmd)
    assert ok is True, err
    stdout, stderr, code = server.execute_command(cmd)
    assert code == 0, stderr
    body = (tmp_path / "fix" / "csp.py").read_text(encoding="utf-8")
    assert 'CSP = "default-src \'self\'"' in body
    assert "Content-Security-Policy" in body
