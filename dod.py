"""Northstar scan-to-fix Definition of Done — same ```dod``` contract as GOAL.md.

One slice per loop. After Print, the first unchecked row is verified against
the command + output (+ fix/csp.py for write-fix). Pass → checked.
"""

from __future__ import annotations

import copy
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

# Seven pipe-separated fields — same layout next-slice.sh / verify-dod.sh parse.
# id | status | verify | spec | cwd | files | title
SCAN_DOD_ROWS: List[Dict[str, str]] = [
    {
        "id": "DOD-01",
        "status": "unchecked",
        "verify": "cmd",
        "spec": "see-finding",
        "cwd": "scan",
        "files": "scan/zap-report.json",
        "title": "See the CSP finding",
    },
    {
        "id": "DOD-02",
        "status": "unchecked",
        "verify": "cmd",
        "spec": "see-code",
        "cwd": "scan",
        "files": "app/login.py",
        "title": "See the login handler",
    },
    {
        "id": "DOD-03",
        "status": "unchecked",
        "verify": "cmd",
        "spec": "write-fix",
        "cwd": "scan",
        "files": "fix/csp.py",
        "title": "Write the CSP fix",
    },
]


def workspace_dir(override: Optional[Path] = None) -> Path:
    if override is not None:
        return Path(override)
    env = (os.getenv("SFISSA_WORKSPACE") or "").strip()
    if env:
        return Path(env)
    return Path(__file__).resolve().parent


def books_dir(override: Optional[Path] = None) -> Path:
    """Compatibility alias — override is the workspace root (parent of fix/)."""
    return workspace_dir(override)


def fresh_rows() -> List[Dict[str, Any]]:
    return copy.deepcopy(SCAN_DOD_ROWS)


def format_registry(rows: List[Dict[str, Any]]) -> str:
    lines = ["```dod"]
    for row in rows:
        lines.append(
            " | ".join(
                [
                    row["id"],
                    row.get("status") or "unchecked",
                    row.get("verify") or "cmd",
                    row.get("spec") or "",
                    row.get("cwd") or "scan",
                    row.get("files") or "",
                    row.get("title") or "",
                ]
            )
        )
    lines.append("```")
    return "\n".join(lines)


def next_slice(rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for row in rows:
        if row.get("status") != "checked":
            return row
    return None


def _blob(command: str, stdout: str, finding: str) -> str:
    return "\n".join([command or "", stdout or "", finding or ""])


def _verify_see_finding(command: str, stdout: str, stderr: str, finding: str) -> Dict[str, Any]:
    cmd = (command or "").strip()
    if cmd.upper() == "EXIT":
        return {"ok": False, "reason": "DOD-01 needs the scan finding, not EXIT."}
    text = _blob(command, stdout, finding)
    has_plugin = "10038" in text
    has_title = bool(
        re.search(r"content security policy \(csp\) header not set|csp header not set", text, flags=re.I)
    )
    if has_plugin or has_title:
        return {"ok": True, "evidence": "Scan names CSP Header Not Set (plugin 10038)"}
    if "command not found" in (stderr or "").lower():
        return {"ok": False, "reason": "Command not found."}
    return {"ok": False, "reason": "Output did not name CSP Header Not Set (plugin 10038)."}


def _verify_see_code(command: str, stdout: str, stderr: str, finding: str) -> Dict[str, Any]:
    cmd = (command or "").strip()
    if cmd.upper() == "EXIT":
        return {"ok": False, "reason": "DOD-02 needs the login handler, not EXIT."}
    text = _blob(command, stdout, finding)
    mentions_login = bool(re.search(r"login\.py|login_headers|handle_login", text, flags=re.I))
    if not mentions_login:
        return {"ok": False, "reason": "Read app/login.py — the login handler."}
    if re.search(r"""["']Content-Security-Policy["']\s*:""", text):
        return {"ok": False, "reason": "app/login.py must still be missing the CSP header."}
    missing_hint = bool(
        re.search(
            r"(no |not set|does not set|missing|without).{0,60}content-security-policy"
            r"|content-security-policy.{0,40}(not set|missing|absent)",
            text,
            flags=re.I,
        )
    )
    shows_handler = bool(re.search(r"login_headers|handle_login|Cache-Control", text))
    if missing_hint or shows_handler:
        return {"ok": True, "evidence": "app/login.py has no Content-Security-Policy header"}
    return {"ok": False, "reason": "Output did not show app/login.py missing Content-Security-Policy."}


_CSP_ASSIGN = re.compile(r"""CSP\s*=\s*["']default-src 'self'["']""")


def _csp_path(workspace: Path) -> Path:
    nested = workspace / "fix" / "csp.py"
    if nested.is_file():
        return nested
    flat = workspace / "csp.py"
    if flat.is_file():
        return flat
    return nested


def _verify_write_fix(
    command: str,
    stdout: str,
    stderr: str,
    finding: str,
    *,
    books: Path,
) -> Dict[str, Any]:
    path = _csp_path(books)
    if path.is_file():
        body = path.read_text(encoding="utf-8")
        if _CSP_ASSIGN.search(body) and "Content-Security-Policy" in body:
            return {"ok": True, "evidence": "fix/csp.py sets Content-Security-Policy: default-src 'self'"}
        return {
            "ok": False,
            "reason": "fix/csp.py must set CSP = default-src 'self' on Content-Security-Policy.",
        }
    if (command or "").strip().upper() != "EXIT":
        return {"ok": False, "reason": "Write fix/csp.py, then EXIT."}
    return {"ok": False, "reason": "fix/csp.py is missing."}


_VERIFIERS = {
    "see-finding": _verify_see_finding,
    "see-code": _verify_see_code,
}


def verify_row(
    row: Dict[str, Any],
    command: str,
    stdout: str,
    stderr: str = "",
    finding: str = "",
    books: Optional[Path] = None,
) -> Dict[str, Any]:
    spec = str(row.get("spec") or "")
    if spec == "write-fix":
        result = _verify_write_fix(command, stdout, stderr, finding, books=workspace_dir(books))
    else:
        fn = _VERIFIERS.get(spec)
        if not fn:
            return {"ok": False, "reason": f"Unknown DoD spec: {row.get('spec')}"}
        result = fn(command, stdout, stderr, finding)
    result["id"] = row["id"]
    result["title"] = row.get("title")
    return result


def _finding_from_turn(turn: Dict[str, Any]) -> str:
    parsed = turn.get("parsed") if isinstance(turn.get("parsed"), dict) else {}
    return str(turn.get("finding") or parsed.get("finding") or "")


def apply_history(history: List[Dict[str, Any]], books: Optional[Path] = None) -> List[Dict[str, Any]]:
    rows = fresh_rows()
    for turn in history or []:
        current = next_slice(rows)
        if not current:
            break
        result = verify_row(
            current,
            str(turn.get("command") or ""),
            str(turn.get("stdout") or ""),
            str(turn.get("stderr") or ""),
            _finding_from_turn(turn),
            books=books,
        )
        if result.get("ok"):
            current["status"] = "checked"
            current["evidence"] = result.get("evidence") or ""
            current.pop("last_attempt", None)
        else:
            current["last_attempt"] = result.get("reason") or "Did not pass."
    return rows


def _serialize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    nxt = next_slice(rows)
    return {
        "rows": rows,
        "next": nxt,
        "complete": nxt is None,
        "markdown": format_registry(rows),
    }


def snapshot_from_history(history: List[Dict[str, Any]], books: Optional[Path] = None) -> Dict[str, Any]:
    return _serialize(apply_history(history, books=books))


def evaluate_print(
    history: List[Dict[str, Any]],
    command: str,
    stdout: str,
    stderr: str = "",
    finding: str = "",
    books: Optional[Path] = None,
) -> Dict[str, Any]:
    rows = apply_history(history, books=books)
    current = next_slice(rows)
    verification: Optional[Dict[str, Any]] = None
    if current:
        verification = verify_row(current, command, stdout, stderr, finding, books=books)
        if verification.get("ok"):
            current["status"] = "checked"
            current["evidence"] = verification.get("evidence") or ""
            current.pop("last_attempt", None)
        else:
            current["last_attempt"] = verification.get("reason") or "Did not pass."
    snap = _serialize(rows)
    snap["current"] = current
    snap["verification"] = verification
    return snap


def dod_prompt_block(history: List[Dict[str, Any]], books: Optional[Path] = None) -> str:
    snap = snapshot_from_history(history, books=books)
    nxt = snap.get("next")
    lines = [
        "DEFINITION OF DONE (machine-checkable — attack ONLY the next unchecked slice):",
        snap["markdown"],
    ]
    if nxt:
        lines.append(f"NEXT SLICE: {nxt['id']} — {nxt['title']}")
        lines.append(f"This loop must satisfy {nxt['id']}. Do not skip ahead.")
        if nxt.get("spec") == "write-fix":
            lines.append("Write fix/csp.py with exactly:")
            lines.append('CSP = "default-src \'self\'"')
            lines.append("# sets response header Content-Security-Policy to that value")
            lines.append("Do not EXIT until that file exists.")
    else:
        lines.append("All DoD slices are checked. COMMAND: EXIT with FINDING if not already.")
    return "\n".join(lines)
