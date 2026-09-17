# Penti demo — SFISSA Workshop #2

<p align="center">
  <a href="https://penti.ai"><img src="docs/penti-logo.svg" alt="Penti" height="36" /></a>
</p>

**Stop Chatting. Start Looping: Live Agents in Production for Cybersecurity Tasks**

SFISSA Workshop #2 · Friday, September 18, 2026 · 15:00–15:45 EDT

A scanner already ran. It found one missing security header. The agent reads the report, finds the code that's missing it, and writes the fix. Look, decide, do, repeat.

This is a local Read → Eval → Print → Loop REPL. It does **not** run a live scan, and it does not send traffic to any host.

---

## What you will see

**Northstar** is a fictional SMB SaaS. A canned OWASP ZAP baseline already produced one finding:

| | |
|---|---|
| Alert | **Content-Security-Policy header not set** |
| Plugin | **10038** |
| Risk | Medium |
| URL | `https://app.northstar.example/login` |

The agent:

1. Reads `scan/zap-report.json` (the JSON file **is** the scan)
2. Reads `app/login.py` (the login handler has no Content-Security-Policy)
3. Writes `fix/csp.py` with `CSP = "default-src 'self'"`

---

## Requirements

- **macOS or Linux** (Windows works with the activate path below)
- **Python 3.10 or newer** (`python3 --version`)
- **At least one LLM API key** — Gemini is the fastest to mint

You do **not** need AWS, Docker, or a Penti account. A stranger with only `GEMINI_API_KEY` can finish this README.

---

## Setup — step by step

### 1. Clone this repo

```bash
git clone https://github.com/securily/penti-demo-ai-sfissa.git
cd penti-demo-ai-sfissa
```

### 2. Create a virtualenv and install Python packages

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Add an API key

```bash
cp .env.example .env
```

Open `.env` in any editor and paste **at least one** real key on the matching line:

| Variable | Where to mint it |
|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |

Optional (only if you already have them): `CURSOR_API_KEY`, `MUSE_API_KEY`.

Do **not** commit `.env`. Do not put key values in the README or the UI.

### 4. Start the server

```bash
python server.py
```

You should see:

```
Northstar CSP REPL → http://127.0.0.1:8785
  Keys present: gemini
```

(`Keys present` lists whichever providers you pasted.)

If port **8785** is already in use, stop the other local demo. Do not change the port.

### 5. Open the demo

In a browser: **http://127.0.0.1:8785**

Click **settings** (top right) to confirm keys show `present`. Pick a model.

**On stage:** press **Autoplay** once. One press runs exactly one full loop (Look → Decide → Do → Repeat) on a single **execution board**. A second press runs the next loop. **Next** still walks the loop by hand. **Restart** resets.

---

## How to walk the loop

Each round is four beats:

1. **Look** — the agent reads `scan/zap-report.json` or `app/login.py`
2. **Decide** — it picks one command (and you can **Run and compare** another model)
3. **Do** — the command runs in a sandbox
4. **Repeat** — keep the result and look again

Definition of done (on screen):

1. See the finding: Content-Security-Policy header not set (plugin 10038)
2. See that `app/login.py` does not set Content-Security-Policy
3. Write `fix/csp.py` so it sets `Content-Security-Policy: default-src 'self'`

Allowed commands: `cat`, `head`, `ls`, `grep`, `python3`, `echo`, and writing `fix/csp.py`. No network from the sandbox.

---

## Restart the scan

If a run already wrote `fix/csp.py`, open **settings** → **Restart scan**, or stop the server and delete `fix/csp.py`. Then refresh the page.

---

## Tests (optional)

```bash
source .venv/bin/activate
python -m pytest -q
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR_CONNECTION_REFUSED` on :8785 | The server is not running. From the repo: `source .venv/bin/activate && python server.py` |
| Settings says a key is `missing` | The value is empty or `.env` is in the wrong folder. Keys must be in `penti-demo-ai-sfissa/.env`. Restart `python server.py` after editing. |
| “No API key for …” when you hit Decide | Same as above — restart after saving `.env`. |
| Port already in use | Something else is on 8785. Stop it. Do not change the port. |
| Cursor models fail | Use Gemini, OpenAI, or Claude. Those three are the stranger path. |

---

## License

MIT — see `LICENSE`.
