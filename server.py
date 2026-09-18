#!/usr/bin/env python3
"""Northstar CSP scan-to-fix REPL — FastAPI on :8785.

Env keys first. Optional SSM backfill uses EDU_SSM_PREFIX from a gitignored .env.
Never logs key values or parameter paths. No network tools. The JSON file is the scan.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from call_cost import usage_anthropic, usage_cursor, usage_gemini, usage_openai
from dod import dod_prompt_block, evaluate_print, snapshot_from_history

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
FIX = ROOT / "fix"
PORT = 8785
MAX_TURNS = 4
FIX.mkdir(parents=True, exist_ok=True)

load_dotenv(ROOT / ".env", override=False)

ALLOWED_BINARIES = frozenset({"cat", "head", "ls", "grep", "python3", "echo"})
BLOCKED_PATTERNS = [
    re.compile(r"\$\("),
    re.compile(r"`"),
    re.compile(r"\|\s*sh\b"),
    re.compile(r"\brm\b"),
    re.compile(r"\bwget\b"),
    re.compile(r"\bssh\b"),
    re.compile(r"\bnmap\b"),
    re.compile(r"\bcurl\b"),
    re.compile(r"\bnc\b"),
    re.compile(r"https?://", re.I),
]


def _has_unquoted_shell_meta(command: str) -> bool:
    """Reject ; | & outside quotes so python3 -c can still use semicolons."""
    in_single = False
    in_double = False
    for ch in command:
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double and ch in {";", "|", "&"}:
            return True
    return False
WRITE_NAME = "csp.py"
_KEY_ENV = {
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "cursor": ("CURSOR_API_KEY",),
    "muse": ("MUSE_API_KEY",),
}
REPL_MODELS = [
    {"provider": "openai", "model": "gpt-5.6-luna", "label": "GPT-5.6 Luna"},
    {"provider": "cursor", "model": "composer-2.5", "label": "Composer 2.5 (Recommended)", "thinking": "high"},
    {"provider": "cursor", "model": "kimi-k2.7-code", "label": "Kimi K2.7 Code", "thinking": "high"},
    {"provider": "cursor", "model": "glm-5.2", "label": "GLM 5.2", "thinking": "high"},
    {"provider": "gemini", "model": "gemini-3.7-flash", "label": "Gemini 3.7 Flash"},
    {"provider": "cursor", "model": "grok-4.6", "label": "Grok 4.6", "thinking": "high"},
    {"provider": "cursor", "model": "kimi-k3", "label": "Kimi K3", "thinking": "high"},
    {"provider": "openai", "model": "gpt-5.6-terra", "label": "GPT-5.6 Terra"},
    {"provider": "anthropic", "model": "claude-sonnet-5", "label": "Claude Sonnet 5"},
]
_edu = (os.getenv("EDU_ROOT") or "").strip()
EDU_ROOT = Path(_edu) if _edu else None
AGENT_ROOT = EDU_ROOT.parent / "agent" if EDU_ROOT else None


def _env_key(*names: str) -> str:
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _key_present(names: tuple[str, ...]) -> bool:
    return bool(_env_key(*names))


def provider_flags() -> Dict[str, bool]:
    return {name: _key_present(envs) for name, envs in _KEY_ENV.items()}


def health_keys() -> Dict[str, bool]:
    flags = provider_flags()
    return {
        "gemini": flags["gemini"],
        "openai": flags["openai"],
        "anthropic": flags["anthropic"],
        "cursor": flags["cursor"],
        "muse": flags["muse"],
    }


def _fill_missing_keys_from_ssm() -> None:
    """Optional staff path. Prefix comes from the environment only — never a committed default."""
    prefix = (os.getenv("EDU_SSM_PREFIX") or "").strip()
    if not prefix:
        return
    missing = [
        env_name
        for env_name, _ in (
            ("GEMINI_API_KEY", None),
            ("OPENAI_API_KEY", None),
            ("ANTHROPIC_API_KEY", None),
            ("CURSOR_API_KEY", None),
            ("MUSE_API_KEY", None),
        )
        if not (os.getenv(env_name) or "").strip()
    ]
    if not missing:
        return
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except Exception:
        return
    prefix = prefix if prefix.endswith("/") else prefix + "/"
    profile = (os.getenv("EDU_AWS_PROFILE") or "").strip() or None
    region = (os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1").strip()
    try:
        session = boto3.Session(profile_name=profile, region_name=region) if profile else boto3.Session(region_name=region)
        ssm = session.client("ssm")
        for env_name in missing:
            leaf = env_name.lower().replace("_", "-")
            try:
                resp = ssm.get_parameter(Name=f"{prefix}{leaf}", WithDecryption=True)
                value = ((resp.get("Parameter") or {}).get("Value") or "").strip()
            except (BotoCoreError, ClientError, Exception):
                continue
            if not value:
                continue
            os.environ[env_name] = value
            if env_name == "GEMINI_API_KEY":
                os.environ.setdefault("GOOGLE_API_KEY", value)
            print(f"  filled {env_name} from SSM")
    except Exception:
        return


_fill_missing_keys_from_ssm()
if (os.getenv("GEMINI_API_KEY") or "").strip() and not (os.getenv("GOOGLE_API_KEY") or "").strip():
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]


def parse_llm_response(text: str) -> Dict[str, str]:
    reasoning = ""
    command = ""
    finding = ""
    raw = str(text or "").strip()
    for line in raw.splitlines():
        upper = line.strip().upper()
        if upper.startswith("REASONING:"):
            reasoning = line.split(":", 1)[1].strip()
        elif upper.startswith("COMMAND:"):
            command = line.split(":", 1)[1].strip()
        elif upper.startswith("FINDING:"):
            finding = line.split(":", 1)[1].strip()
    if not command:
        match = re.search(r"```(?:bash|sh|shell)?\s*\n?([^`]+)```", raw, re.IGNORECASE)
        if match:
            command = match.group(1).strip().splitlines()[0]
    if not command:
        command = _extract_shell_command(raw)
    if not reasoning and command:
        reasoning = raw.split("COMMAND:")[0].replace("REASONING:", "").strip()[:500]
    return {"reasoning": reasoning, "command": command, "finding": finding, "raw": raw}


def _extract_shell_command(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    upper = raw.upper()
    if upper in {"EXIT", "DONE"} or upper.startswith("EXIT "):
        return "EXIT"
    match = re.search(r"(?im)^\s*((?:cat|head|ls|grep|python3|echo)\s+[^\n`]+)", raw)
    if match:
        return match.group(1).strip().rstrip(".,;")
    if upper.strip() == "LS":
        return "ls"
    return ""


def _first_token(command: str) -> str:
    try:
        parts = shlex.split(command.strip())
    except ValueError:
        parts = command.strip().split()
    return parts[0] if parts else ""


def _redirect_dest(command: str) -> Optional[str]:
    match = re.search(r"(?:>>|>)\s*(\S+)", command)
    return match.group(1) if match else None


def _resolve_under_root(raw: str) -> Optional[Path]:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = (ROOT / raw).resolve()
    else:
        candidate = candidate.resolve()
    try:
        candidate.relative_to(ROOT)
    except ValueError:
        return None
    return candidate


def _touches_env_file(command: str) -> bool:
    """Quoted or unquoted .env paths, including python3 -c open('.env')."""
    if re.search(r"\.env(?:['\"\s]|$)", command):
        return True
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.split()
    return any(Path(part).name.startswith(".env") for part in parts)


def validate_command(command: str) -> Tuple[bool, str]:
    cmd = command.strip()
    if not cmd:
        return False, "Empty command"
    if cmd.upper() == "EXIT":
        return True, ""
    for pat in BLOCKED_PATTERNS:
        if pat.search(cmd):
            return False, f"Blocked pattern: {pat.pattern}"
    token = _first_token(cmd)
    if token not in ALLOWED_BINARIES:
        return False, f"Allowed commands: {', '.join(sorted(ALLOWED_BINARIES))}"
    if _has_unquoted_shell_meta(cmd):
        return False, "Blocked pattern: unquoted shell chaining"
    if _touches_env_file(cmd):
        return False, "Cannot read env files"
    dest = _redirect_dest(cmd)
    if dest:
        path = _resolve_under_root(dest)
        if path is None or path.name != WRITE_NAME or path.parent != FIX.resolve():
            return False, f"Redirects may only write fix/{WRITE_NAME}"
    for match in re.finditer(r"(?:^|\s)([\w./-]+\.\w+|[\w./-]+/[\w./-]+)", cmd):
        raw = match.group(1).strip()
        if raw.startswith("-"):
            continue
        path = _resolve_under_root(raw)
        if path is None:
            return False, f"Path escapes sandbox: {raw}"
    return True, ""


_SECRET_ENV_NAMES = frozenset({
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_API_KEY",
})


def _sandbox_env() -> Dict[str, str]:
    env = os.environ.copy()
    for key in list(env):
        upper = key.upper()
        if (
            key in _SECRET_ENV_NAMES
            or "API_KEY" in upper
            or upper.endswith(("_SECRET", "_TOKEN", "_PASSWORD"))
        ):
            env.pop(key, None)
    env["HOME"] = str(ROOT)
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    return env


def execute_command(command: str, timeout: int = 15) -> Tuple[str, str, int]:
    ok, err = validate_command(command)
    if not ok:
        return "", err, 1
    if command.strip().upper() == "EXIT":
        return "", "", 0
    env = _sandbox_env()
    try:
        result = subprocess.run(
            ["bash", "-c", command],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        return result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", f"Command timed out after {timeout}s", -1
    except Exception as exc:
        return "", str(exc), -1


SYSTEM_PROMPT = """You close a missing-header finding for Northstar.

A scanner already ran. Read scan/zap-report.json. Find the login code that is missing
Content-Security-Policy. Write the fix to fix/csp.py.

When the next slice is write-fix, write this exact file (two lines) with python3:

CSP = "default-src 'self'"
# sets response header Content-Security-Policy to that value

Example command (copy this — it uses chr() so the quotes stay valid):
python3 -c "open('fix/csp.py','w').write('CSP = '+chr(34)+'default-src '+chr(39)+'self'+chr(39)+chr(34)+chr(10)+'# sets response header Content-Security-Policy to that value'+chr(10))"

Do not EXIT until that file exists with those two lines.

Reply with exactly these lines:
REASONING: <why this command>
COMMAND: <one shell command>
FINDING: <only when you EXIT>

Allowed: cat, head, ls, grep, python3, echo
No network. Only the next unchecked DoD slice.
When fix/csp.py sets Content-Security-Policy to default-src 'self', COMMAND: EXIT.
"""


def _build_user_prompt(history: List[Dict[str, Any]]) -> str:
    lines = [
        "Northstar: close the missing Content-Security-Policy finding.",
        f"You have at most {MAX_TURNS} loops.",
    ]
    if not history:
        lines.append("No previous command output yet (first loop).")
    else:
        lines.append("PREVIOUS LOOPS (Print output — this is your READ context):")
        for turn in history:
            lines.append(f"--- Loop {turn.get('turn')} ---")
            lines.append(f"Command: {turn.get('command')}")
            lines.append(f"stdout:\n{turn.get('stdout') or '(empty)'}")
            if turn.get("stderr"):
                lines.append(f"stderr:\n{turn['stderr']}")
    lines.append(dod_prompt_block(history))
    return "\n".join(lines)


def _llm_generate(provider: str, model: str, system: str, user_prompt: str) -> Tuple[str, Dict[str, Any]]:
    flags = provider_flags()
    if not flags.get(provider):
        raise HTTPException(400, f"No API key for {provider}. Set the matching env var in .env and restart.")
    if provider == "openai":
        return _openai_chat(model, system, user_prompt)
    if provider == "anthropic":
        return _anthropic_chat(model, system, user_prompt)
    if provider == "gemini":
        return _gemini_chat(model, system, user_prompt)
    if provider == "cursor":
        return _cursor_chat(model, system, user_prompt)
    raise HTTPException(400, f"Provider {provider} is not callable in this demo.")


def _provider_http_error(name: str, resp: httpx.Response) -> HTTPException:
    kind = ""
    try:
        err = (resp.json() or {}).get("error") or {}
        kind = str(err.get("type") or err.get("code") or "")[:80]
    except Exception:
        kind = ""
    detail = f"{name} call failed ({resp.status_code}" + (f" {kind}" if kind else "") + ")"
    return HTTPException(502, detail)


def _openai_chat(model: str, system: str, user_prompt: str) -> Tuple[str, Dict[str, Any]]:
    key = _env_key("OPENAI_API_KEY")
    body: Dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_prompt},
        ],
    }
    # GPT-5 chat models reject legacy max_tokens / temperature.
    if str(model).lower().startswith("gpt-5"):
        body["max_completion_tokens"] = 800
    else:
        body["max_tokens"] = 600
        body["temperature"] = 0.2
    resp = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=body,
        timeout=60.0,
    )
    if resp.status_code >= 400:
        raise _provider_http_error("OpenAI", resp)
    data = resp.json()
    text = str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    return text, usage_openai(data, model, system, user_prompt, text)


def _anthropic_chat(model: str, system: str, user_prompt: str) -> Tuple[str, Dict[str, Any]]:
    key = _env_key("ANTHROPIC_API_KEY")
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 600,
            "system": system,
            "messages": [{"role": "user", "content": user_prompt}],
        },
        timeout=60.0,
    )
    if resp.status_code >= 400:
        raise _provider_http_error("Anthropic", resp)
    data = resp.json()
    parts = data.get("content") or []
    text = "".join(str(p.get("text") or "") for p in parts if p.get("type") == "text")
    return text, usage_anthropic(data, model, system, user_prompt, text)


def _cursor_chat(model: str, system: str, user_prompt: str) -> Tuple[str, Dict[str, Any]]:
    """Optional staff Cursor models. Unset EDU_ROOT → unavailable. Do not vendor an SDK."""
    import sys

    if EDU_ROOT is None or AGENT_ROOT is None:
        raise HTTPException(502, "Cursor eval is unavailable.")
    if str(EDU_ROOT) not in sys.path:
        sys.path.insert(0, str(EDU_ROOT))
    try:
        from shared.edu_llm import cursor_eval_generate
    except Exception as exc:
        raise HTTPException(502, f"Cursor eval is unavailable: {exc}") from exc
    ws = ROOT / ".composer-eval"
    ws.mkdir(parents=True, exist_ok=True)
    thinking = "high"
    for row in REPL_MODELS:
        if row.get("model") == model:
            thinking = str(row.get("thinking") or "high")
            break
    text, raw_usage = cursor_eval_generate(
        demo_dir=EDU_ROOT / "composer-demo-presentation",
        composer_sdk=AGENT_ROOT / "sdk" / "composer",
        agent_root=AGENT_ROOT,
        workspace_cfg={"workspace_dir": str(ws)},
        model_id=model,
        thinking=thinking,
        system=system,
        user_prompt=user_prompt,
    )
    return text, usage_cursor(raw_usage if isinstance(raw_usage, dict) else None, model, system, user_prompt, text)


def _gemini_chat(model: str, system: str, user_prompt: str) -> Tuple[str, Dict[str, Any]]:
    key = _env_key("GEMINI_API_KEY", "GOOGLE_API_KEY")
    resp = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        params={"key": key},
        json={
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"maxOutputTokens": 800, "temperature": 0.2},
        },
        timeout=60.0,
    )
    if resp.status_code >= 400:
        raise HTTPException(502, f"Gemini call failed ({resp.status_code})")
    data = resp.json()
    candidates = data.get("candidates") or []
    parts = (((candidates[0] or {}).get("content") or {}).get("parts") or []) if candidates else []
    text = "".join(str(p.get("text") or "") for p in parts)
    return text, usage_gemini(data, model, system, user_prompt, text)


app = FastAPI(title="Northstar CSP scan-to-fix REPL")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")


class TurnRequest(BaseModel):
    provider: str = ""
    model: str = ""
    history: List[Dict[str, Any]] = Field(default_factory=list)


class PrintStepRequest(BaseModel):
    command: str
    history: List[Dict[str, Any]] = Field(default_factory=list)
    parsed: Dict[str, Any] = Field(default_factory=dict)


class JudgeRequest(BaseModel):
    candidates: List[Dict[str, Any]] = Field(default_factory=list)
    history: List[Dict[str, Any]] = Field(default_factory=list)


def _turn_number(history: List[Dict[str, Any]]) -> int:
    return len(history) + 1


def _reset_entry() -> None:
    FIX.mkdir(parents=True, exist_ok=True)
    path = FIX / WRITE_NAME
    if path.exists():
        path.unlink()


def _nocache(path, media: str) -> FileResponse:
    return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})


@app.get("/")
async def index() -> FileResponse:
    return _nocache(STATIC / "index.html", "text/html")


@app.get("/presentation.css")
async def presentation_css() -> FileResponse:
    return _nocache(STATIC / "presentation.css", "text/css")


@app.get("/stage.js")
async def stage_js() -> FileResponse:
    return _nocache(STATIC / "stage.js", "text/javascript")


@app.get("/shared/dod-ui.js")
async def dod_ui_js() -> FileResponse:
    return _nocache(STATIC / "dod-ui.js", "text/javascript")


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "mode": "csp-repl", "keys": health_keys()}


@app.get("/api/models")
async def models() -> Dict[str, Any]:
    flags = provider_flags()
    available = [row for row in REPL_MODELS if flags.get(row["provider"])]
    return {
        "models": available or REPL_MODELS,
        "keys": {
            "gemini": flags["gemini"],
            "openai": flags["openai"],
            "anthropic": flags["anthropic"],
            "cursor": flags["cursor"],
        },
    }


@app.get("/api/dod")
async def get_dod() -> Dict[str, Any]:
    return snapshot_from_history([])


@app.post("/api/reset")
async def reset() -> Dict[str, Any]:
    _reset_entry()
    return {"ok": True, "dod": snapshot_from_history([])}


@app.post("/api/step/read")
async def step_read(body: TurnRequest) -> Dict[str, Any]:
    if len(body.history) >= MAX_TURNS:
        raise HTTPException(400, f"This demo allows at most {MAX_TURNS} turns.")
    user_prompt = _build_user_prompt(body.history)
    return {
        "turn": _turn_number(body.history),
        "step": "read",
        "prompt": {"system": SYSTEM_PROMPT, "user": user_prompt, "briefing": user_prompt},
        "dod": snapshot_from_history(body.history),
    }


@app.post("/api/step/eval")
async def step_eval(body: TurnRequest) -> Dict[str, Any]:
    if len(body.history) >= MAX_TURNS:
        raise HTTPException(400, f"This demo allows at most {MAX_TURNS} turns.")
    user_prompt = _build_user_prompt(body.history)
    try:
        response_text, usage = _llm_generate(body.provider, body.model, SYSTEM_PROMPT, user_prompt)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"LLM call failed: {exc}") from exc
    parsed = parse_llm_response(response_text)
    cmd = (parsed.get("command") or "").strip()
    if cmd and cmd.upper() != "EXIT":
        ok, err = validate_command(cmd)
        if not ok:
            parsed["print_warning"] = err
    return {
        "turn": _turn_number(body.history),
        "step": "eval",
        "prompt": {"system": SYSTEM_PROMPT, "user": user_prompt},
        "llm_response": response_text,
        "parsed": parsed,
        "command": parsed["command"],
        "usage": usage,
    }


@app.post("/api/step/print")
async def step_print(body: PrintStepRequest) -> Dict[str, Any]:
    cmd = (body.command or "").strip()
    stdout, stderr, return_code = "", "", 0
    validation_error = None
    if cmd.upper() == "EXIT":
        pass
    elif cmd:
        ok, err = validate_command(cmd)
        if not ok:
            validation_error = err
            stderr = err
            return_code = 1
        else:
            stdout, stderr, return_code = execute_command(cmd)
    else:
        validation_error = "Could not parse COMMAND from LLM response"
        stderr = validation_error
        return_code = 1
    finding = str((body.parsed or {}).get("finding") or "")
    result: Dict[str, Any] = {
        "step": "print",
        "command": cmd,
        "stdout": stdout,
        "stderr": stderr,
        "return_code": return_code,
        "validation_error": validation_error,
        "finding": finding,
        "turn": _turn_number(body.history),
    }
    result["dod"] = evaluate_print(body.history, cmd, stdout, stderr, finding)
    result["done"] = bool(result["dod"].get("complete")) or cmd.upper() == "EXIT" or result["turn"] >= MAX_TURNS
    return result


def _parse_judge_reply(text: str, n: int) -> Tuple[int, List[int], str]:
    raw = (text or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
    raw = re.sub(r"\s*```\s*$", "", raw)
    blob = raw
    match = re.search(r"\{[\s\S]*", raw)
    if match:
        blob = match.group(0)
    data: Optional[Dict[str, Any]] = None
    for candidate in (blob, blob + "]", blob + "]}", blob + "\n}", blob + "]\n}"):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                data = parsed
                break
        except Exception:
            continue
    if data is None:
        win_m = re.search(r'"winner"\s*:\s*(\d+)', raw)
        scores_m = re.search(r'"scores"\s*:\s*\[([^\]]*)', raw)
        winner = int(win_m.group(1)) if win_m else 1
        scores = []
        if scores_m:
            scores = [int(x) for x in re.findall(r"\d+", scores_m.group(1))]
        return max(1, min(n or 1, winner)), scores[:n], ""
    winner = int(data.get("winner") or 1)
    scores = []
    for x in data.get("scores") or []:
        try:
            scores.append(int(x))
        except (TypeError, ValueError):
            continue
    verdict = str(data.get("verdict") or "").strip()
    if verdict.startswith("{") or verdict.startswith("```"):
        verdict = ""
    return max(1, min(n or 1, winner)), scores[: n or len(scores)], verdict


def _extract_action(command: str) -> str:
    cmd = (command or "").strip()
    low = cmd.lower()
    if not cmd:
        return "No command. Worth 0."
    if cmd.upper() == "EXIT":
        return "Stop and report the finding."
    if "zap-report" in low:
        return "Read the OWASP ZAP results (see the CSP finding)."
    if "login.py" in low:
        return "Read the login handler (the page missing the header)."
    if "csp.py" in low or "fix/" in low:
        return "Write the CSP fix file."
    if low.startswith("ls"):
        return "List files in the folder."
    if low.startswith(("cat ", "head ", "grep ")):
        return "Read a file: " + cmd
    return "Run this command: " + cmd


def _business_verdict(verdict: str, pick_label: str, actions: List[str]) -> str:
    text = re.sub(r"\s+", " ", (verdict or "").strip())
    if text and not text.startswith("{") and not text.startswith("```") and len(text) > 12:
        return text
    name = pick_label or "This model"
    useful = next((a for a in actions if a and not a.startswith("No command")), "")
    if useful and len(set(actions)) == 1:
        return (
            f"{name} wins on cost, not on writing. Both replies do the same useful thing: {useful} "
            "The longer essay is not extra value."
        )
    return (
        f"{name} wins on the useful action, not the essay. "
        + (useful or "The useful move is the one that finishes this DOD row.")
    )


@app.post("/api/judge")
async def judge(body: JudgeRequest) -> Dict[str, Any]:
    flags = provider_flags()
    provider = "gemini" if flags.get("gemini") else ("openai" if flags.get("openai") else "anthropic")
    model = next((m["model"] for m in REPL_MODELS if m["provider"] == provider), "")
    n = len(body.candidates)
    extracted: List[Dict[str, str]] = []
    for cand in body.candidates:
        cmd = str(cand.get("command") or "").strip()
        extracted.append(
            {
                "label": str(cand.get("label") or ""),
                "command": cmd,
                "action": _extract_action(cmd),
                "cost": str(cand.get("cost_usd") if cand.get("cost_usd") is not None else ""),
            }
        )
    lines = [
        "You are a pragmatic judge. Extra words are not value.",
        "Extract the useful action from each reply: the one command, and what it does for this DOD row.",
        "Ignore essays, length, tone, hedging, and extra explanation. Those score 0.",
        "A long reply with the same command is not better. Same useful action = same score.",
        "If the useful actions are the same, pick the cheaper call as winner.",
        "If one action finishes the DOD row and the other does not, the useful one wins even if it is shorter.",
        'JSON only, no fences: {"winner":1,"scores":[8,9],"verdict":"..."}',
        "verdict: two short sentences. Name the winner. Name the useful action. Say if the other was the same action with more text.",
        "",
        "Packets (score ACTION + COMMAND only):",
    ]
    for i, item in enumerate(extracted, start=1):
        essay = str(body.candidates[i - 1].get("reasoning") or "").strip()
        cost = item["cost"]
        cost_bit = f" · this call cost {cost}" if cost != "" else ""
        lines.append(f"{i}. {item['label']}{cost_bit}")
        lines.append(f"USEFUL ACTION: {item['action']}")
        lines.append(f"COMMAND: {item['command'] or '—'}")
        if essay:
            lines.append("ESSAY (do not score): " + essay[:280])
        lines.append("")
    text, usage = _llm_generate(
        provider,
        model,
        "You are a pragmatic judge. Score the useful action only. Extra text is worth 0. JSON only.",
        "\n".join(lines),
    )
    winner, scores, verdict = _parse_judge_reply(text, n)
    pick = ""
    if 1 <= winner <= n:
        pick = str(extracted[winner - 1].get("label") or "").split("·")[0].strip()
    verdict = _business_verdict(verdict, pick, [e["action"] for e in extracted])
    return {
        "winner": winner,
        "scores": scores,
        "verdict": verdict,
        "judge_model": model,
        "usage": usage,
        "judge_cost_usd": (usage or {}).get("estimated_cost"),
        "extracted": extracted,
    }


def _print_key_status() -> None:
    flags = health_keys()
    print(f"Northstar CSP REPL → http://127.0.0.1:{PORT}")
    present = [name for name, ok in flags.items() if ok]
    if present:
        print(f"  Keys present: {', '.join(present)}")
    else:
        print("  No keys yet — copy .env.example to .env and paste GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.")


if __name__ == "__main__":
    import uvicorn

    _print_key_status()
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
