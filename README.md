<p align="center">
  <img src="docs/readme-lockup.png" width="420" alt="Penti and South Florida ISSA">
</p>

<h1 align="center">Penti demo — SFISSA Workshop #2</h1>

<p align="center">
  <strong>Stop Chatting. Start Looping</strong><br>
  Live agents in production for cybersecurity tasks
</p>

<p align="center">
  Friday, September 18, 2026 · 15:00–15:45 EDT · Boca Raton<br>
  Proud sponsor of <a href="https://www.sfissahtf.com/">Hack the Flag and Chili Cookoff</a>
</p>

A local **Look → Decide → Do → Repeat** REPL. OWASP ZAP already ran. One finding remains: `/login` is missing Content-Security-Policy.

**DOD** means Definition of Done — the checklist this turn is set to complete. We do not scan live, and we do not send traffic to any host.

---

## What you will see

**Northstar** is a fictional SMB SaaS. A canned OWASP ZAP baseline already produced one finding:

| | |
|---|---|
| Alert | **Content-Security-Policy header not set** |
| Plugin | **10038** |
| Risk | Medium |
| URL | `https://app.northstar.example/login` |

Each turn completes one DOD row:

1. **DOD-01** — See the CSP finding in the ZAP report (`scan/zap-report.json` **is** the scan)
2. **DOD-02** — See the login handler that is missing the header (`app/login.py`)
3. **DOD-03** — Write `fix/csp.py` with `CSP = "default-src 'self'"`

---

## Requirements

- **macOS or Linux** (Windows works with the activate path below)
- **Python 3.10 or newer** (`python3 --version`)
- **At least one LLM API key** — Gemini is the fastest to mint

You do **not** need AWS, Docker, or a Penti account. One `GEMINI_API_KEY` is enough to finish this README.

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

**On stage:** press **Autoplay** once. One press runs exactly one full turn (Look → Decide → Do → Repeat) on a single **execution board**. Look shows the OWASP ZAP results. **Next** after a pause starts the next turn. If you never press Autoplay, **Next** walks the same loop by hand. **Restart** resets.

---

## How to walk the loop

Each round is four beats:

1. **Look** — read the OWASP ZAP results (and later, the login code)
2. **Decide** — ask a language model for one command (and you can **Run and compare** another model)
3. **Do** — run that command in a sandbox
4. **Repeat** — check the result against the DOD, then pause or start the next turn

DOD on screen (Definition of Done — what we are set to complete):

1. **DOD-01** — See the finding: Content-Security-Policy header not set (plugin 10038)
2. **DOD-02** — See that `app/login.py` does not set Content-Security-Policy
3. **DOD-03** — Write `fix/csp.py` so it sets `Content-Security-Policy: default-src 'self'`

Allowed commands: `cat`, `head`, `ls`, `grep`, `python3`, `echo`, and writing `fix/csp.py`. No network from the sandbox.

---

## Restart this demo

If a run already wrote `fix/csp.py`, open **settings** → **Restart this demo**, or stop the server and delete `fix/csp.py`. Then refresh the page.

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
| Cursor models fail | Use Gemini, OpenAI, or Claude. |

---

## License

MIT — see `LICENSE`.
