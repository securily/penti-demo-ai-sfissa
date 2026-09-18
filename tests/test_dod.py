"""Canned Print-output tests for Northstar CSP DoD verifiers."""

from __future__ import annotations

from pathlib import Path

from dod import evaluate_print, fresh_rows, snapshot_from_history, verify_row

FINDING_STDOUT = """
"pluginid": "10038",
"alert": "Content Security Policy (CSP) Header Not Set",
"riskdesc": "Medium (Medium)",
"uri": "https://app.northstar.example/login"
"""

LOGIN_STDOUT = '''
def login_headers() -> dict[str, str]:
    return {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
    }
'''

FIX_PY = '''CSP = "default-src 'self'"

def apply(headers: dict) -> dict:
    headers["Content-Security-Policy"] = CSP
    return headers
'''


def _row(spec: str):
    return next(r for r in fresh_rows() if r["spec"] == spec)


def test_see_finding_passes_on_plugin_and_title():
    result = verify_row(_row("see-finding"), "cat scan/zap-report.json", FINDING_STDOUT)
    assert result["ok"] is True
    assert "10038" in result["evidence"]
    assert "CSP Header Not Set" in result["evidence"]


def test_see_finding_passes_on_plugin_only():
    result = verify_row(_row("see-finding"), "grep pluginid scan/zap-report.json", 'pluginid": "10038"')
    assert result["ok"] is True


def test_see_finding_rejects_exit():
    result = verify_row(_row("see-finding"), "EXIT", "", finding="CSP Header Not Set")
    assert result["ok"] is False


def test_see_finding_rejects_empty():
    result = verify_row(_row("see-finding"), "cat scan/zap-report.json", "")
    assert result["ok"] is False


def test_see_code_passes_on_login_headers():
    result = verify_row(_row("see-code"), "cat app/login.py", LOGIN_STDOUT)
    assert result["ok"] is True
    assert "Content-Security-Policy" in result["evidence"]


def test_see_code_passes_missing_phrase():
    result = verify_row(
        _row("see-code"),
        "cat app/login.py",
        "login.py does not set Content-Security-Policy",
    )
    assert result["ok"] is True


def test_see_code_rejects_exit():
    result = verify_row(_row("see-code"), "EXIT", "", finding="login.py has no CSP")
    assert result["ok"] is False


def test_see_code_rejects_without_login():
    result = verify_row(_row("see-code"), "echo hi", "no Content-Security-Policy")
    assert result["ok"] is False


def test_see_code_rejects_header_already_set():
    result = verify_row(
        _row("see-code"),
        "cat app/login.py",
        '{"Content-Security-Policy": "default-src \'self\'"}',
    )
    assert result["ok"] is False


def test_write_fix_passes_on_exit_and_file(tmp_path: Path):
    (tmp_path / "fix").mkdir()
    (tmp_path / "fix" / "csp.py").write_text(FIX_PY, encoding="utf-8")
    result = verify_row(
        _row("write-fix"),
        "EXIT",
        "",
        finding="Set Content-Security-Policy to default-src self",
        books=tmp_path,
    )
    assert result["ok"] is True


def test_write_fix_passes_on_write_when_file_exists(tmp_path: Path):
    (tmp_path / "fix").mkdir()
    (tmp_path / "fix" / "csp.py").write_text(FIX_PY, encoding="utf-8")
    result = verify_row(_row("write-fix"), "cat fix/csp.py", FIX_PY, books=tmp_path)
    assert result["ok"] is True


def test_write_fix_rejects_missing_file(tmp_path: Path):
    result = verify_row(_row("write-fix"), "EXIT", "", books=tmp_path)
    assert result["ok"] is False


def test_write_fix_rejects_wrong_csp(tmp_path: Path):
    (tmp_path / "fix").mkdir()
    (tmp_path / "fix" / "csp.py").write_text(
        'CSP = "default-src *"\nheaders["Content-Security-Policy"] = CSP\n',
        encoding="utf-8",
    )
    result = verify_row(_row("write-fix"), "EXIT", "", books=tmp_path)
    assert result["ok"] is False


def test_write_fix_rejects_missing_header_name(tmp_path: Path):
    (tmp_path / "fix").mkdir()
    (tmp_path / "fix" / "csp.py").write_text("CSP = \"default-src 'self'\"\n", encoding="utf-8")
    result = verify_row(_row("write-fix"), "EXIT", "", books=tmp_path)
    assert result["ok"] is False


def test_evaluate_print_advances_slices(tmp_path: Path):
    (tmp_path / "fix").mkdir()
    (tmp_path / "fix" / "csp.py").write_text(FIX_PY, encoding="utf-8")
    first = evaluate_print([], "cat scan/zap-report.json", FINDING_STDOUT, books=tmp_path)
    assert first["verification"]["ok"] is True
    assert first["rows"][0]["status"] == "checked"
    assert first["next"]["id"] == "DOD-02"

    history = [{"command": "cat scan/zap-report.json", "stdout": FINDING_STDOUT}]
    second = evaluate_print(history, "cat app/login.py", LOGIN_STDOUT, books=tmp_path)
    assert second["verification"]["ok"] is True
    assert second["next"]["id"] == "DOD-03"

    history.append({"command": "cat app/login.py", "stdout": LOGIN_STDOUT})
    third = evaluate_print(
        history,
        "EXIT",
        "",
        finding="Wrote fix/csp.py",
        books=tmp_path,
    )
    assert third["verification"]["ok"] is True
    assert third["complete"] is True


def test_snapshot_starts_at_see_finding():
    snap = snapshot_from_history([])
    assert snap["next"]["spec"] == "see-finding"
    assert snap["complete"] is False
