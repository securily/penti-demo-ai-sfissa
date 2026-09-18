/* Northstar CSP REPL — wizard walkthrough plus Autoplay one-screen board. */
(function () {
  "use strict";

  var MAX_TURNS = 4;
  var BOOKS = "scan/";
  var GOALS = [
    "DOD-01 — See the CSP finding in the ZAP report",
    "DOD-02 — See the login handler that is missing the header",
    "DOD-03 — Write the CSP fix in fix/csp.py",
  ];
  var ZAP_RESULTS = [
    "Tool: OWASP ZAP baseline (already ran — we are not scanning live)",
    "Alert: Content Security Policy (CSP) Header Not Set",
    "Plugin: 10038",
    "Risk: Medium",
    "URL: https://app.northstar.example/login",
    "What ZAP said: The response does not include a Content-Security-Policy header.",
    "What ZAP wants: Set the Content-Security-Policy response header."
  ].join("\n");
  var PC = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)"];
  var STEPS = [
    { id: "read", letter: "R", name: "Look", plain: "Read ZAP", verb: "Read the OWASP ZAP results. See the one finding." },
    { id: "eval", letter: "E", name: "Decide", plain: "Ask the model", verb: "Ask a language model for the one next command. Compare cost if we call two." },
    { id: "print", letter: "P", name: "Do", plain: "Run it", verb: "Run that command in the sandbox and show what came back." },
    { id: "loop", letter: "↻", name: "Repeat", plain: "Check DOD", verb: "Check the result against the DOD. Then pause, or start the next turn." },
  ];

  var stage = document.getElementById("stage");
  var railEl = document.getElementById("rail");
  var counterEl = document.getElementById("counter");
  var btnNext = document.getElementById("btnNext");
  var btnBack = document.getElementById("btnBack");
  var hintEl = document.getElementById("hint");
  var toast = document.getElementById("toast");
  var modelSelect = document.getElementById("modelSelect");
  var modal = document.getElementById("settingsModal");

  var history = [], loopDraft = null, frames = [], pos = 0, pending = null, finding = null, busy = false, lastDod = null;
  var lastLlmPrompt = "";
  var boardRound = 0, boardStepIdx = 0;
  var MODELS = [];
  var evalRunsByRound = {};
  var selectedRunByRound = {};
  var judgeByRound = {};
  var typedKeys = new Set();
  var typers = [];
  var runGen = 0;

  function stillCurrent(gen) { return gen === runGen; }

  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function b64enc(s) { try { return btoa(unescape(encodeURIComponent(String(s == null ? "" : s)))); } catch (e) { return ""; } }
  function b64dec(b) { try { return decodeURIComponent(escape(atob(b || ""))); } catch (e) { return ""; } }
  function stripCredits(s) { return String(s || "").replace(/\s*·.*$/, "").replace(/\s*\(Recommended\)/i, "").trim(); }
  function normCmd(c) { return String(c || "").toLowerCase().replace(/\s+/g, " ").trim(); }
  function modelLabelFor(id) { for (var i = 0; i < MODELS.length; i++) { if (MODELS[i].model === id) return stripCredits(MODELS[i].label || id); } return id; }
  function usdLabel(n) {
    var x = Number(n);
    if (!isFinite(x) || x < 0) x = 0;
    if (x === 0) return "$0.00";
    if (x < 0.01) return "$" + x.toFixed(4);
    if (x < 1) return "$" + x.toFixed(3);
    return "$" + x.toFixed(2);
  }
  function runUsd(r) {
    if (!r) return 0;
    if (r.cost_usd != null) return Number(r.cost_usd) || 0;
    if (r.usage && r.usage.estimated_cost != null) return Number(r.usage.estimated_cost) || 0;
    return 0;
  }
  function callCostLine(r) {
    var usd = usdLabel(runUsd(r));
    var tokens = r && r.tokens != null ? Number(r.tokens) : (r && r.usage && r.usage.total_tokens);
    if (tokens) return usd + " · " + Number(tokens).toLocaleString("en-US") + " tokens";
    return usd;
  }
  function dollars(n) {
    var v = parseInt(String(n).replace(/[^\d-]/g, ""), 10);
    if (isNaN(v)) return String(n);
    return "$" + v.toLocaleString("en-US");
  }
  function withDollars(s) {
    var t = String(s == null ? "" : s);
    t = t.replace(/\$10,000/g, "\u0001").replace(/\$0\b/g, "\u0002");
    t = t.replace(/\b10[, ]?000\b/g, "\u0001");
    t = t.replace(/\bspent\s+0\b/gi, "spent \u0002");
    t = t.replace(/\bleft(?:over)?\s+0\b/gi, "leftover \u0002");
    return t.replace(/\u0001/g, "$10,000").replace(/\u0002/g, "$0");
  }
  function audience(s) { return withDollars(s); }
  function formatBooksOut(text) {
    var raw = String(text || "");
    if (/\$/.test(raw)) return withDollars(raw);
    var lines = raw.split("\n");
    if (!lines[0] || lines[0].indexOf(",") < 0 || !/budget|spent|left/i.test(lines[0])) return withDollars(raw);
    return lines.map(function (line, i) {
      if (!i) return line;
      return line.split(",").map(function (cell, j) {
        if (!j || !/^-?\d+$/.test(cell.trim())) return cell;
        return dollars(cell.trim());
      }).join(",");
    }).join("\n");
  }
  function decorateMoneyHtml(escaped) {
    return String(escaped || "").replace(/\$10,000|\$0\b/g, function (m) {
      var cls = "money" + (m === "$10,000" ? " leftover" : " zero");
      return '<span class="' + cls + '">' + m + "</span>";
    });
  }
  function truncate(s, n) { var t = (s || "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : t.slice(0, n) + "…"; }
  function clipEvidence(s, n) {
    var t = String(s == null ? "" : s).replace(/[ \t]+\n/g, "\n").trim();
    return t.length <= n ? t : t.slice(0, n) + "…";
  }
  function showToast(m) { toast.textContent = m; toast.classList.add("show"); setTimeout(function () { toast.classList.remove("show"); }, 5000); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function payload() {
    var o = modelSelect.selectedOptions[0] || {}, d = o.dataset || {};
    if (!d.provider && MODELS[0]) d = { provider: MODELS[0].provider, model: MODELS[0].model };
    return { provider: d.provider, model: d.model, history: history };
  }
  function modelName() { var o = modelSelect.selectedOptions[0]; return o ? o.textContent.replace(/·.*$/, "").trim() : "the model"; }
  async function apiPost(path, body) {
    var res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var data = await res.json(); if (!res.ok) throw new Error(data.detail || res.statusText); return data;
  }
  function splitReasoning(raw, command) {
    var body = String(raw || ""), i = body.search(/COMMAND\s*:/i);
    var r = (i >= 0 ? body.slice(0, i) : body).replace(/^\s*REASONING\s*:/i, "").trim();
    if (!r && command) r = "(model returned the command with no written reasoning)";
    return r;
  }

  function ring(activeIdx) {
    var size = 360, c = size / 2, r = 118, angles = [-90, 0, 90, 180], nodes = "";
    var comet = '<circle class="ring-track" cx="' + c + '" cy="' + c + '" r="' + r + '"/>' +
                '<circle class="ring-comet" cx="' + c + '" cy="' + c + '" r="' + r + '"/>';
    for (var i = 0; i < 4; i++) {
      var a = angles[i] * Math.PI / 180, x = c + r * Math.cos(a), y = c + r * Math.sin(a);
      var cls = activeIdx === -1 ? "on" : (i < activeIdx ? "done" : (i === activeIdx ? "on" : "off"));
      nodes += '<g class="ring-node ' + cls + '" style="--nc:' + PC[i] + '">' +
        '<circle cx="' + x + '" cy="' + y + '" r="' + (cls === "on" ? 40 : 34) + '"/>' +
        '<text x="' + x + '" y="' + (y + 1) + '">' + STEPS[i].letter + "</text></g>";
    }
    return '<svg class="loop-ring" viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="Look, Decide, Do, Repeat">' + comet + nodes + "</svg>";
  }

  function head(stepIdx, round) {
    var s = STEPS[stepIdx];
    return '<div class="wiz-phasechip"><span class="pc-badge" style="--pc:' + PC[stepIdx] + '">' + s.letter + "</span></div>" +
      '<p class="wiz-kicker">/ Round ' + round + " · " + esc(s.name) + " · " + esc(GOALS[round - 1] || "") + "</p>" +
      '<h1 class="wiz-heading">' + esc(s.name) + "</h1>" +
      '<p class="wiz-plain">' + esc(s.plain) + "</p>" +
      '<p class="wiz-lede">' + esc(s.verb) + "</p>";
  }
  function split(form, aside, extraClass) {
    return '<section class="scene scene-split' + (extraClass ? " " + extraClass : "") + '"><div class="split-form"><div class="split-form-inner">' + form +
      '</div></div><div class="split-aside penti-dotgrid">' + aside + "</div></section>";
  }
  function center(inner) { return '<section class="scene scene-center"><div class="scene-center-inner">' + inner + "</div></section>"; }

  function dodHtml(dod) {
    if (!dod || typeof renderDodRegistry !== "function") return "";
    return '<div class="dod-stage">' + renderDodRegistry(dod) + "</div>";
  }
  function introScene() {
    var stats = [
      { n: "01", label: "OWASP ZAP already ran", value: "ZAP baseline", note: "The JSON file is the scan. We do not probe the live site.", tone: "" },
      { n: "02", label: "One ZAP finding", value: "CSP missing", note: "Plugin 10038 — Content-Security-Policy header is not set.", tone: "" },
      { n: "03", label: "Where it hits", value: "/login", note: "Northstar’s sign-in page never sends that header.", tone: " bad" }
    ];
    var cards = '<div class="stat-row">' + stats.map(function (s) {
      return '<article class="stat-card' + s.tone + '">' +
        '<p class="stat-label">' + esc(s.n) + " · " + esc(s.label) + "</p>" +
        '<p class="stat-num">' + esc(s.value) + "</p>" +
        '<p class="stat-note">' + esc(s.note) + "</p></article>";
    }).join("") + "</div>";
    var sheet =
      '<figure class="sheet">' +
        '<div class="sheet-bar"><span class="sheet-tab">zap-report.json</span><span class="sheet-path">Exhibit · scan/</span></div>' +
        '<table class="sheet-table">' +
          "<thead><tr>" +
            '<th class="sheet-rownum" scope="col"></th>' +
            '<th scope="col">Alert</th>' +
            '<th scope="col">Risk</th>' +
            '<th scope="col">URL</th>' +
            '<th scope="col">Plugin</th>' +
          "</tr></thead>" +
          "<tbody><tr>" +
            '<th class="sheet-rownum" scope="row">1</th>' +
            "<td>Content Security Policy (CSP) Header Not Set</td>" +
            "<td>Medium</td>" +
            '<td class="sheet-bad"><span class="sheet-flag">/login</span></td>' +
            '<td class="sheet-bad"><span class="sheet-flag">10038</span><span class="sheet-why">header missing</span></td>' +
          "</tr></tbody>" +
        "</table>" +
        '<figcaption class="sheet-cap">These are the OWASP ZAP results. One header is missing. We read the report, find the login code, and write the fix.</figcaption>' +
      "</figure>";
    return '<section class="scene scene-center scene-problem"><div class="scene-center-inner">' +
      '<div class="problem">' +
      '<p class="wiz-kicker">/ Northstar · SFISSA Workshop #2 · Fri Sep 18, 2026</p>' +
      '<div class="accent-bar" aria-hidden="true"></div>' +
      '<h1 class="problem-title">/login is missing <span class="money leftover">Content-Security-Policy</span></h1>' +
      '<p class="problem-lede">Northstar already ran OWASP ZAP. The results are on this screen. One finding remains: /login never sets Content-Security-Policy. We look, decide, do, and repeat — one DOD row per turn.</p>' +
      cards + sheet +
      '<p class="problem-ask">DOD means Definition of Done — the checklist of what we are set to complete. Read the ZAP results. Find the login handler. Write fix/csp.py with CSP = default-src \'self\'.</p>' +
      '<ol class="loop-key">' + STEPS.map(function (s) {
        return '<li><span class="loop-key-name">' + esc(s.name) + '</span>' +
          '<span class="loop-key-plain">' + esc(s.plain) + "</span>" +
          '<span class="loop-key-verb">' + esc(s.verb) + "</span></li>";
      }).join("") + "</ol>" +
      '<button type="button" class="wiz-next intro-autoplay" data-act="autoplay">Autoplay</button>' +
      "</div></div></section>";
  }
  function filesScene() {
    var files = [
      {
        n: "01",
        path: "scan/zap-report.json",
        name: "The OWASP ZAP results",
        what: "The OWASP ZAP results. One alert. Already ran.",
        info: "pluginid 10038 · CSP Header Not Set · /login",
        means: "This JSON is the scan. Look starts here — we do not scan live."
      },
      {
        n: "02",
        path: "app/login.py",
        name: "The login handler",
        what: "Northstar’s /login response in code.",
        info: "Content-Type and Cache-Control only. No Content-Security-Policy.",
        means: "This is the handler ZAP flagged. DOD-02 is to see this file."
      },
      {
        n: "03",
        path: "scan/GOAL.md",
        name: "The DOD",
        what: "DOD means Definition of Done — what we are set to complete.",
        info: "DOD-01 see the finding → DOD-02 see the code → DOD-03 write the fix",
        means: "One unchecked DOD row per turn. Do not skip ahead."
      },
      {
        n: "04",
        path: "fix/csp.py",
        name: "The fix",
        what: "Not in the folder yet. We write it on DOD-03.",
        info: "CSP = default-src 'self' on Content-Security-Policy",
        means: "When this file exists and sets that header, the ZAP finding is closed."
      }
    ];
    var cards = '<ol class="file-grid">' + files.map(function (f) {
      return '<li class="file-card">' +
        '<p class="file-kicker">' + esc(f.n) + " · " + esc(f.path) + "</p>" +
        '<h2 class="file-name">' + esc(f.name) + "</h2>" +
        '<p class="file-what">' + esc(f.what) + "</p>" +
        '<pre class="file-info">' + esc(f.info) + "</pre>" +
        '<p class="file-means">' + esc(f.means) + "</p></li>";
    }).join("") + "</ol>";
    return '<section class="scene scene-center scene-problem scene-files"><div class="scene-center-inner">' +
      '<div class="problem">' +
      '<p class="wiz-kicker">/ The folder · scan/ and app/</p>' +
      '<div class="accent-bar" aria-hidden="true"></div>' +
      '<h1 class="problem-title">The files this demo will use</h1>' +
      '<p class="problem-lede">Three files are already here. One is missing. The missing file is the fix we write when DOD-03 is the job.</p>' +
      cards +
      "</div></div></section>";
  }
  function readScene(round, data) {
    var prev = history[history.length - 1];
    var last = round === 1 ? "First turn. No command has run yet. The OWASP ZAP results are already on disk." : (prev && prev.stdout ? formatBooksOut(prev.stdout) : "(the last command returned nothing)");
    var dod = (data && data.dod) || lastDod;
    var nextGoal = (dod && dod.next) ? (dod.next.id + " — " + dod.next.title) : (GOALS[round - 1] || "every DOD row is done");
    var form = head(0, round) +
      '<div class="ctx-card">' +
      '<div class="ctx-row"><span class="ctx-k">Folder</span><code class="ctx-v">' + esc(BOOKS) + "</code></div>" +
      '<div class="ctx-row"><span class="ctx-k">Last result</span><div class="ctx-v dim ctx-scroll" data-twk="r' + round + '-last" data-tw="' + b64enc(last) + '"></div></div>' +
      '<div class="ctx-row"><span class="ctx-k">DOD this turn</span><span class="ctx-v">' + esc(nextGoal) + "</span></div></div>" +
      dodHtml(dod);
    var aside = '<p class="aside-title">This turn · ' + round + " of " + MAX_TURNS + "</p>" + ring(0);
    return split(form, aside);
  }
  function thinkingScene(round, stepIdx, title, sub) {
    var form = head(stepIdx, round) +
      '<div class="thinking"><span class="think-orb" style="--pc:' + PC[stepIdx] + '"></span>' +
      '<div><p class="think-t">' + esc(title) + '</p><p class="think-s">' + esc(sub) + "</p></div>" +
      '<span class="think-dots"><i></i><i></i><i></i></span></div>';
    return split(form, '<p class="aside-title">This turn</p>' + ring(stepIdx));
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  var lastLlmRole = "model";
  var lastShownCost = null;
  var lastCostCompare = { kind: "", text: "", n: 0 };
  function costVsKind(curr, prev) {
    if (prev == null || !isFinite(prev)) return "";
    if (curr < prev) return "cheaper";
    if (curr > prev) return "dearer";
    return "same";
  }
  function costVsLabel(kind, prev) {
    if (kind === "cheaper") return "Cheaper than the last call (" + usdLabel(prev) + ")";
    if (kind === "dearer") return "More expensive than the last call (" + usdLabel(prev) + ")";
    if (kind === "same") return "Same cost as the last call";
    return "";
  }
  function costCompare(usd) {
    var n = Number(usd);
    if (!isFinite(n) || n < 0) n = 0;
    var kind = costVsKind(n, lastShownCost);
    return { kind: kind, text: costVsLabel(kind, lastShownCost), n: n };
  }
  function costFrom(data) {
    if (!data) return 0;
    if (data.judge_cost_usd != null) return Number(data.judge_cost_usd) || 0;
    if (data.cost_usd != null) return Number(data.cost_usd) || 0;
    if (data.usage && data.usage.estimated_cost != null) return Number(data.usage.estimated_cost) || 0;
    return runUsd(data);
  }
  function hideLlmCost() {
    var el = document.getElementById("llmCostUsd");
    var wrap = document.getElementById("llmCost");
    var vs = document.getElementById("llmCostVs");
    if (el) el.textContent = "";
    if (vs) { vs.textContent = ""; vs.hidden = true; }
    if (wrap) {
      wrap.setAttribute("data-ready", "0");
      wrap.setAttribute("data-vs", "");
      wrap.setAttribute("aria-hidden", "true");
    }
  }
  function revealLlmCost(usd) {
    var el = document.getElementById("llmCostUsd");
    var wrap = document.getElementById("llmCost");
    var vs = document.getElementById("llmCostVs");
    if (!el || !wrap) return;
    lastCostCompare = costCompare(usd);
    el.textContent = usdLabel(lastCostCompare.n);
    if (vs) {
      vs.textContent = lastCostCompare.text;
      vs.hidden = !lastCostCompare.text;
    }
    wrap.setAttribute("data-vs", lastCostCompare.kind || "first");
    wrap.setAttribute("data-ready", "0");
    wrap.removeAttribute("aria-hidden");
    void wrap.offsetWidth;
    wrap.setAttribute("data-ready", "1");
    lastShownCost = lastCostCompare.n;
  }
  function setLlmPhase(phase) {
    var modal = document.getElementById("llmModal");
    if (!modal) return;
    var el = modal.querySelector(".llm-pulse");
    if (el) el.setAttribute("data-phase", phase);
    var titles = lastLlmRole === "judge"
      ? {
        request: "Sending both answers to the judge…",
        wait: "The judge is scoring the two commands…",
        receive: "The judge decided. Typing the verdict…"
      }
      : {
        request: "Sending this prompt to the model…",
        wait: "The model is thinking…",
        receive: "The model answered. Typing what it sent back…"
      };
    var t = modal.querySelector(".llm-pulse-title");
    if (t) t.textContent = titles[phase] || titles.wait;
  }
  function showLlmPopup(name, phase, opts) {
    var modal = document.getElementById("llmModal");
    if (!modal) return;
    lastLlmRole = opts && opts.role === "judge" ? "judge" : "model";
    modal.setAttribute("data-role", lastLlmRole);
    var kicker = modal.querySelector(".llm-modal-kicker");
    if (kicker) kicker.textContent = lastLlmRole === "judge" ? "Asking the judge" : "Asking the language model";
    var lab = modal.querySelector(".llm-model .llm-node-lab");
    if (lab) lab.textContent = lastLlmRole === "judge" ? "Judge" : "LLM";
    var card = modal.querySelector(".llm-modal-card");
    if (card) card.setAttribute("aria-label", lastLlmRole === "judge" ? "Asking the judge" : "Asking the language model");
    var sub = modal.querySelector(".llm-pulse-sub");
    if (sub) sub.textContent = name || (lastLlmRole === "judge" ? "the judge" : "the model");
    hideLlmCost();
    setLlmPhase(phase || "request");
    modal.hidden = false;
  }
  function hideLlmPopup() {
    var modal = document.getElementById("llmModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("data-role", "model");
    lastLlmRole = "model";
    hideLlmCost();
  }
  function rememberPrompt(data) {
    var p = data && data.prompt;
    var text = p && (p.user || p.briefing);
    if (text) lastLlmPrompt = String(text);
    return lastLlmPrompt;
  }
  function fallbackPrompt() {
    var lines = ["Northstar: close the missing Content-Security-Policy finding."];
    if (lastDod && lastDod.next) lines.push("DOD this turn (what I am set to complete): " + lastDod.next.id + " — " + lastDod.next.title);
    else if (lastDod && lastDod.complete) lines.push("Every DOD row is complete.");
    if (history.length) {
      var h = history[history.length - 1];
      lines.push("Last command: " + (h.command || "—"));
      lines.push("Last result:\n" + clipEvidence(h.stdout || "(empty)", 500));
    } else {
      lines.push("First loop. No previous output yet.");
    }
    return lines.join("\n");
  }
  function replyFrom(data) {
    if (!data) return "(no response)";
    if (data.llm_response) return audience(data.llm_response);
    if (data.verdict) return String(data.verdict);
    var cmd = (data.command || "").trim();
    var reason = (data.parsed && data.parsed.reasoning) || "";
    if (reason || cmd) {
      return (reason ? "REASONING: " + audience(reason) + "\n\n" : "") + (cmd ? "COMMAND: " + cmd : "");
    }
    return "(empty response)";
  }
  function typeBox(el, text) {
    return new Promise(function (resolve) {
      if (!el) { resolve(); return; }
      var full = clipEvidence(String(text || ""), 2400);
      var settled = false;
      var iv = null;
      var watchdog = null;
      var caret = '<span class="tw-caret">▋</span>';
      var done = function () {
        if (settled) return;
        settled = true;
        if (iv) clearInterval(iv);
        if (watchdog) clearTimeout(watchdog);
        el.innerHTML = esc(full);
        resolve();
      };
      if (!full) { el.innerHTML = ""; done(); return; }
      var dur = Math.min(20000, 2200 + full.length * 52);
      var t0 = Date.now();
      el.innerHTML = caret;
      iv = setInterval(function () {
        var p = (Date.now() - t0) / dur;
        if (p >= 1) { done(); return; }
        var n = Math.max(1, Math.round(full.length * p));
        el.innerHTML = esc(full.slice(0, n)) + caret;
        el.scrollTop = el.scrollHeight;
      }, 32);
      el.style.cursor = "pointer";
      el.onclick = done;
      watchdog = setTimeout(done, 22000);
    });
  }
  async function withLlmPulse(name, work, promptText, opts) {
    var promptEl = document.getElementById("llmPrompt");
    var replyEl = document.getElementById("llmReply");
    var send = String(promptText || lastLlmPrompt || fallbackPrompt());
    if (promptEl) promptEl.innerHTML = "";
    if (replyEl) replyEl.innerHTML = "";
    showLlmPopup(name, "request", opts);
    await typeBox(promptEl, send);
    setLlmPhase("wait");
    if (replyEl) replyEl.innerHTML = '<span class="tw-caret">▋</span>';
    try {
      var result = await work();
      if (result && result.prompt) rememberPrompt(result);
      revealLlmCost(costFrom(result));
      setLlmPhase("receive");
      await typeBox(replyEl, replyFrom(result));
      await sleep(1800);
      return result;
    } finally {
      hideLlmPopup();
    }
  }
  function extractAction(cmd) {
    var c = String(cmd || "").trim();
    var low = c.toLowerCase();
    if (!c) return "No command. Worth 0.";
    if (c.toUpperCase() === "EXIT") return "Stop and report the finding.";
    if (low.indexOf("zap-report") >= 0) return "Read the OWASP ZAP results (see the CSP finding).";
    if (low.indexOf("login.py") >= 0) return "Read the login handler (the page missing the header).";
    if (low.indexOf("csp.py") >= 0 || low.indexOf("fix/") >= 0) return "Write the CSP fix file.";
    if (low.indexOf("ls") === 0) return "List files in the folder.";
    return "Run this command: " + c;
  }
  function buildJudgePrompt(runs) {
    var lines = [
      "You are a pragmatic judge. Extra words are not value.",
      "Extract the useful action from each reply: the one command, and what it does for this DOD row.",
      "Ignore essays, length, tone, and extra explanation. Those score 0.",
      "A long reply with the same command is not better. Same useful action = same score. If they match, pick the cheaper call.",
      ""
    ];
    (runs || []).forEach(function (r, i) {
      lines.push((i + 1) + ". " + r.name + " · this call cost " + callCostLine(r));
      lines.push("USEFUL ACTION: " + extractAction(r.command));
      lines.push("COMMAND: " + (r.command || "—"));
      lines.push("ESSAY (do not score): " + clipEvidence(r.reasoning || "", 280));
      lines.push("");
    });
    lines.push("Score 1–10 on the useful action only. Name the winner. Say if the other was the same action with more text.");
    return lines.join("\n");
  }
  async function askJudge(runs) {
    return withLlmPulse("Judge", function () {
      return apiPost("/api/judge", {
        candidates: runs.map(function (r) {
          return { label: r.name, command: r.command, reasoning: r.reasoning, cost_usd: runUsd(r) };
        }),
        history: history
      });
    }, buildJudgePrompt(runs), { role: "judge" });
  }
  function judgeDecisionText(judge, runs) {
    var parsed = (judge && !judge.pending) ? normalizeJudge(judge, runs) : null;
    var pick = parsed ? (runs[parsed.winnerIdx] || {}) : {};
    var lines = [
      "JUDGE DECISION",
      "Winner: " + (pick.name || "—") + (parsed && parsed.scores[parsed.winnerIdx] != null ? " · " + parsed.scores[parsed.winnerIdx] + "/10" : ""),
      parsed ? parsed.why : "(no verdict yet)",
      "",
      "USEFUL ACTION (what the judge scored — extra text is worth 0)"
    ];
    if (judge && judge.extracted && judge.extracted.length) {
      judge.extracted.forEach(function (item) {
        lines.push((item.label || "Model") + ": " + (item.action || extractAction(item.command)));
      });
    } else {
      (runs || []).forEach(function (r) {
        lines.push(r.name + ": " + extractAction(r.command));
      });
    }
    lines.push("", "COSTS");
    (runs || []).forEach(function (r) {
      lines.push(r.name + ": " + callCostLine(r));
    });
    lines.push("Judge: " + usdLabel(costFrom(judge)));
    return lines.join("\n");
  }
  function cmpControls(runs) {
    var used = {}; runs.forEach(function (r) { used[r.model] = 1; });
    var picked = false, opts = "";
    MODELS.forEach(function (m) {
      var sel = (!picked && !used[m.model]) ? " selected" : "";
      if (sel) picked = true;
      opts += '<option value="' + esc(m.model) + '" data-provider="' + esc(m.provider) + '"' + sel + '>' + esc(stripCredits(m.label || m.model)) + "</option>";
    });
    return '<div class="cmp-controls"><label class="cmp-label">Keep this answer. Run a second model on the same DOD job.</label>' +
      '<div class="cmp-row"><select id="cmpModel" aria-label="Second model to compare">' + opts + "</select>" +
      '<button type="button" class="cmp-run" data-act="run-model">Run and compare</button></div>' +
      '<p class="cmp-hint">Same ZAP facts. Same DOD row. Then we compare the command and the cost.</p></div>';
  }

  function runCardHtml(r, baseCmd, isLatest, isSelected, idx, score, isWinner, round) {
    var diff = normCmd(r.command) !== normCmd(baseCmd);
    var action = isSelected
      ? '<span class="cmp-using">✓ Using this command in Do</span>'
      : '<button type="button" class="cmp-use" data-act="use-run" data-idx="' + idx + '">Use this command →</button>';
    var scoreBadge = (score != null && score > 0) ? '<span class="cmp-score">' + esc(String(score)) + '/10</span>' : "";
    var runs = evalRunsByRound[round] || [];
    var prior = idx > 0 ? runUsd(runs[idx - 1]) : null;
    var vs = costVsKind(runUsd(r), prior);
    var costBadge = '<span class="cmp-cost' + (vs ? " " + vs : "") + '">Cost ' + esc(usdLabel(runUsd(r))) +
      (vs ? '<em>' + esc(costVsLabel(vs, prior)) + "</em>" : "") + "</span>";
    var winBadge = isWinner ? '<span class="judge-pick">Judge’s pick</span>' : "";
    return '<div class="cmp-card' + (isSelected ? " selected" : "") + (isWinner ? " judge-win" : "") + (diff ? " diverged" : "") + '">' +
      '<div class="cmp-card-head"><span class="model-chip">' + esc(r.name) + "</span>" +
      '<span class="cmp-head-right">' + costBadge + scoreBadge + '<span class="cmp-verdict">' + (diff ? "different command" : "same command") + "</span></span></div>" +
      winBadge +
      (isLatest ? '<code class="cmp-cmd" data-twk="r' + round + '-cmd-' + idx + '" data-tw="' + b64enc(r.command) + '"></code>'
                : '<code class="cmp-cmd">' + esc(r.command) + "</code>") + action +
      '<div class="cmp-reasoning"' + (isLatest ? ' data-twk="r' + round + '-reason-' + idx + '" data-tw="' + b64enc(audience(r.reasoning)) + '"' : "") + ">" +
      (isLatest ? "" : decorateMoneyHtml(esc(audience(r.reasoning)))) + "</div></div>";
  }

  function evalScene(round) {
    var runs = evalRunsByRound[round] || [];
    var latest = runs[runs.length - 1] || { name: modelName(), reasoning: "", command: "" };

    if (runs.length <= 1) {
      var li = runs.length - 1;
      var form = head(1, round) +
        '<div class="model-chip">' + esc(latest.name) + "</div>" +
        '<p class="eval-cost"><span class="cost-lab">This call cost</span><span class="cost-usd">' + esc(usdLabel(runUsd(latest))) + "</span></p>" +
        '<div class="cmd-box"><span class="cmd-cap">Command this model chose</span><code class="cmd-big" data-twk="r' + round + '-cmd-' + li + '" data-tw="' + b64enc(latest.command) + '"></code></div>' +
        cmpControls(runs);
      var aside = '<div class="reason-card"><p class="aside-title">Why the model picked that command</p><div class="aside-reasoning" data-twk="r' + round + '-reason-' + li + '" data-tw="' + b64enc(audience(latest.reasoning)) + '"></div></div>';
      return split(form, aside, "scene-eval");
    }

    var base = runs[0].command;
    var allSame = runs.every(function (r) { return normCmd(r.command) === normCmd(base); });
    var selIdx = (round in selectedRunByRound) ? selectedRunByRound[round] : runs.length - 1;
    var banner = '<div class="cmp-banner ' + (allSame ? "same" : "diff") + '">' +
      (allSame ? "All " + runs.length + " models chose the <b>same</b> command for this DOD row"
               : "The models <b>disagreed</b> — different commands for the same DOD row") + "</div>";
    var judge = judgeByRound[round];
    var parsed = (judge && !judge.pending) ? normalizeJudge(judge, runs) : null;
    var winnerIdx = parsed ? parsed.winnerIdx : -1;
    var cards = runs.map(function (r, i) {
      return runCardHtml(r, base, i === runs.length - 1, i === selIdx, i, parsed ? parsed.scores[i] : null, i === winnerIdx, round);
    }).join("");
    return center(head(1, round) + banner + '<div class="cmp-grid">' + cards + "</div>" + judgePanelHtml(judge, parsed, runs) + cmpControls(runs));
  }

  function normalizeJudge(judge, runs) {
    var winner = Number(judge && judge.winner) || 1;
    var scores = (judge && judge.scores) ? judge.scores.slice() : [];
    var why = String((judge && judge.verdict) || "").trim();
    if (why.indexOf("{") === 0 || why.indexOf("```") === 0) {
      try {
        var blob = why.replace(/^```(?:json)?/i, "").replace(/```$/, "");
        var m = blob.match(/\{[\s\S]*/);
        var data = m ? JSON.parse(m[0].replace(/,(\s*[\]}])/g, "$1")) : null;
        if (data) {
          if (data.winner) winner = Number(data.winner);
          if (data.scores) scores = data.scores;
          why = String(data.verdict || "").trim();
        }
      } catch (e) {
        var wm = why.match(/"winner"\s*:\s*(\d+)/);
        var sm = why.match(/"scores"\s*:\s*\[([^\]]*)/);
        if (wm) winner = Number(wm[1]);
        if (sm) scores = sm[1].match(/\d+/g) || [];
        why = "";
      }
    }
    var idx = Math.max(0, Math.min(runs.length - 1, winner - 1));
    scores = scores.map(function (x) { return Number(x); }).filter(function (x) { return !isNaN(x); });
    if (!why || why.charAt(0) === "{") {
      var name = runs[idx] ? runs[idx].name : "This command";
      var sc = scores[idx];
      why = name + " is the pick" + (sc ? " at " + sc + "/10." : ".");
    }
    return { winnerIdx: idx, scores: scores, why: why };
  }

  function judgePanelHtml(judge, parsed, runs) {
    if (judge && judge.pending) {
      return '<aside class="judge-panel pending"><p class="judge-kicker">Judge’s verdict</p><p class="judge-why">A third model is scoring which command finishes this DOD row.</p></aside>';
    }
    if (!judge || !parsed) {
      return '<div class="judge-cta"><button type="button" class="judge-btn" data-act="judge">Judge these commands</button>' +
        '<span class="judge-cta-hint">Ask another model which command is closer to finishing this DOD row.</span></div>';
    }
    var pick = runs[parsed.winnerIdx] || {};
    var pickScore = parsed.scores[parsed.winnerIdx];
    var value = valueCallout(parsed, runs);
    var lastRun = runs[runs.length - 1];
    var judgeVs = costVsKind(costFrom(judge), lastRun ? runUsd(lastRun) : null);
    var judgeVsLabel = judgeVs ? costVsLabel(judgeVs, runUsd(lastRun)) : "";
    var scoreRow = parsed.scores.length ? '<div class="judge-scores">' + runs.map(function (r, i) {
      var s = parsed.scores[i];
      if (s == null) return "";
      return '<span class="judge-score' + (i === parsed.winnerIdx ? " win" : "") + '">' +
        '<span class="judge-score-name">' + esc(r.name) + "</span>" +
        "<b>" + esc(String(s)) + "/10</b>" +
        '<span class="judge-score-cost">' + esc(usdLabel(runUsd(r))) + "</span></span>";
    }).join("") + "</div>" : "";
    return '<aside class="judge-panel">' +
      '<p class="judge-kicker">Judge’s verdict' +
      (judge.judge_model ? ' · <span class="judge-model">' + esc(stripCredits(judge.judge_model)) + "</span>" : "") +
      "</p>" +
      '<p class="eval-cost' + (judgeVs ? " " + judgeVs : "") + '"><span class="cost-lab">Judge call cost</span><span class="cost-usd">' + esc(usdLabel(costFrom(judge))) + "</span>" +
      (judgeVsLabel ? "<em>" + esc(judgeVsLabel) + "</em>" : "") + "</p>" +
      '<p class="judge-pick-title">' + esc(pick.name || "Pick") +
      (pickScore != null ? ' <span class="judge-pick-score">' + esc(String(pickScore)) + "/10</span>" : "") +
      "</p>" +
      (value.badge ? '<p class="judge-value ' + value.cls + '">' + esc(value.badge) + "</p>" : "") +
      '<p class="judge-pick-sub">' + esc(value.sub) + "</p>" +
      scoreRow +
      '<p class="judge-why">' + decorateMoneyHtml(esc(withDollars(parsed.why))) + "</p></aside>";
  }

  function valueCallout(parsed, runs) {
    var w = parsed.winnerIdx;
    var pick = runs[w] || {};
    var winCost = runUsd(pick);
    var others = runs.filter(function (_, i) { return i !== w; });
    var cheaperThanAll = others.every(function (r) { return winCost < runUsd(r); });
    var cheapest = others.every(function (r) { return winCost <= runUsd(r); });
    var minOther = others.reduce(function (m, r) {
      var c = runUsd(r);
      return m == null || c < m ? c : m;
    }, null);
    var name = pick.name || "This model";
    if (cheaperThanAll) {
      return { badge: "Cheaper and better", cls: "win", sub: name + " won, and it cost the least — " + usdLabel(winCost) + "." };
    }
    if (cheapest) {
      return { badge: "Best at this cost", cls: "tie", sub: name + " won. Same cost as the cheapest other call — " + usdLabel(winCost) + "." };
    }
    return {
      badge: "Better, not cheaper",
      cls: "mix",
      sub: name + " won at " + usdLabel(winCost) + ". A cheaper call was " + usdLabel(minOther) + "."
    };
  }

  async function runEvalModel(round, meta, provider, model, newFrame) {
    var gen = runGen;
    busy = true;
    var thinking = thinkingScene(round, 1, "Asking a language model for the next command…", modelLabelFor(model));
    if (newFrame) { pushFrame(thinking, meta); pos = frames.length - 1; }
    else { frames[pos] = { html: thinking, meta: meta }; }
    render();
    try {
      var d = await withLlmPulse(modelLabelFor(model), function () {
        return apiPost("/api/step/eval", { provider: provider, model: model, history: history });
      }, lastLlmPrompt);
      if (!stillCurrent(gen) || !loopDraft) return;
      var cmd = (d.command || "").trim();
      if (!cmd) throw new Error("Model returned no command. Raw: " + truncate(d.llm_response || "", 160));
      var reasoning = (d.parsed && d.parsed.reasoning) || splitReasoning(d.llm_response, cmd);
      loopDraft.command = cmd; loopDraft.parsed = d.parsed || {};
      (evalRunsByRound[round] = evalRunsByRound[round] || []).push({
        provider: provider,
        model: model,
        name: modelLabelFor(model),
        usage: d.usage || {},
        cost_usd: d.usage && d.usage.estimated_cost != null ? Number(d.usage.estimated_cost) : 0,
        tokens: d.usage && d.usage.total_tokens != null ? Number(d.usage.total_tokens) : 0,
        reasoning: audience(reasoning),
        command: cmd,
        finding: audience((d.parsed && d.parsed.finding) || "")
      });
      selectedRunByRound[round] = evalRunsByRound[round].length - 1;
      frames[pos] = { html: evalScene(round), meta: meta };
      pending = { kind: "step", round: round, stepIdx: 2 };
    } catch (e) {
      if (!stillCurrent(gen)) return;
      showToast(e.message);
      if ((evalRunsByRound[round] || []).length) { frames[pos] = { html: evalScene(round), meta: meta }; }
      else if (newFrame) { frames.pop(); pos = frames.length - 1; }
    } finally {
      if (stillCurrent(gen)) { busy = false; render(); }
    }
    if (stillCurrent(gen) && !newFrame && (evalRunsByRound[round] || []).length >= 2) { await runJudge(round, meta); }
  }

  function findingTextFrom(data) {
    var fromDraft = loopDraft && loopDraft.parsed && loopDraft.parsed.finding;
    var fromServer = data && typeof data.stdout === "string" ? data.stdout.trim() : "";
    return (data && data.parsed && data.parsed.finding) || fromDraft || fromServer || "Reported.";
  }
  function printScene(round, data) {
    var cmd = (data.command || loopDraft.command || "").trim(), isExit = cmd.toUpperCase() === "EXIT", body;
    if (isExit) body = '<div class="finding-banner"><span>FINDING</span><p data-twk="r'+round+'-finding" data-tw="' + b64enc(withDollars(findingTextFrom(data))) + '"></p></div>';
    else if (data.validation_error) body = '<div class="terminal"><div class="term-body"><pre class="term-blocked">Blocked: ' + esc(data.validation_error) + "</pre></div></div>";
    else {
      var out = (data.stdout || "").trim(), err = (data.stderr || "").trim(), inner = "";
      if (out) inner += '<pre class="term-stdout">' + decorateMoneyHtml(esc(formatBooksOut(out))) + "</pre>";
      if (err) inner += '<pre class="term-stderr">' + esc(err) + "</pre>";
      if (!inner) inner = '<pre class="term-empty">(no output — exit code ' + (data.return_code != null ? data.return_code : 0) + ")</pre>";
      body = '<div class="terminal"><div class="term-bar"><span class="term-dot r"></span><span class="term-dot y"></span><span class="term-dot g"></span>' +
        '<span class="term-cmd">' + esc(BOOKS) + " · " + esc(cmd) + '</span></div><div class="term-body">' + inner + "</div></div>";
    }
    return center(head(2, round) + body + dodHtml((data && data.dod) || lastDod));
  }
  function loopScene(round, data) {
    var isExit = ((data && data.command) || "").toUpperCase() === "EXIT" || finding, learned;
    var v = data && data.dod && data.dod.verification;
    if (isExit) learned = "The demo reported the finding and stopped.";
    else if (v && v.ok) learned = v.id + " passed. That DOD row is complete. " + withDollars(v.evidence || "");
    else if (v && v.ok === false) learned = (v.id || "This DOD row") + " did not pass. " + withDollars(v.reason || "");
    else { var out = (data && data.stdout || "").trim(); learned = out ? "From that command: " + formatBooksOut(out) : "That command returned nothing — the next turn tries another way."; }
    var dodDone = data && data.dod && data.dod.complete;
    var nextLine = (round < MAX_TURNS && !isExit && !dodDone) ? "Turn " + (round + 1) + " starts again with Look — next DOD row." : "Every DOD row is done — the missing header has a fix.";
    var form = head(3, round) + '<div class="loop-focus"><div>' + ring(3) + '</div><div><p class="loop-learned" data-twk="r'+round+'-loop" data-tw="' + b64enc(learned) + '"></p><p class="loop-next">' + esc(nextLine) + "</p></div></div>" + dodHtml((data && data.dod) || lastDod);
    return '<section class="scene scene-center"><div class="scene-center-inner" style="max-width:760px">' + form + "</div></section>";
  }
  function outroScene() {
    var recap = history.map(function (h, i) { return '<li><span class="recap-n">' + (i + 1) + "</span><code>" + esc(h.command || "—") + "</code></li>"; }).join("");
    return center('<div class="hero"><div class="hero-ring">' + ring(-1) + "</div><div>" +
      '<p class="wiz-kicker">' + (lastDod && lastDod.complete ? "Every DOD row is checked" : "The loop finished") + '</p><h1 class="hero-title">The loop <span>closed</span></h1>' +
      (finding ? '<div class="finding-banner"><span>FINDING</span><p data-twk="outro-finding" data-tw="' + b64enc(withDollars(finding)) + '"></p></div>'
        : '<p class="hero-lede">The OWASP ZAP finding is closed. /login now has a CSP fix.</p>') +
      dodHtml(lastDod) +
      '<ol class="recap">' + recap + "</ol></div></div>");
  }

  function railFor(meta) {
    var activePhase = meta.kind === "step" ? meta.stepIdx : (meta.kind === "outro" ? 4 : -1);
    railEl.innerHTML = STEPS.map(function (s, i) {
      var cls = "rail-step" + (i < activePhase ? " done" : "") + (i === activePhase ? " active" : "");
      var item = '<div class="rail-item"><span class="' + cls + '"><span class="rail-num">' + (i + 1) + '</span><span class="rail-label">' + esc(s.name) + "</span></span>";
      if (i < STEPS.length - 1) item += '<span class="rail-conn"></span>';
      return item + "</div>";
    }).join("");
    var round = meta.kind === "step" ? meta.round : (meta.kind === "outro" ? MAX_TURNS : 1);
    counterEl.textContent = "[ " + pad(round) + " / " + pad(MAX_TURNS) + " ]";
  }

  function pushFrame(html, meta) { frames.push({ html: html, meta: meta }); }
  function clearTypers() { typers.forEach(function (t) { clearInterval(t); }); typers = []; }
  function selectedModel() {
    var opt = modelSelect && modelSelect.selectedOptions[0];
    if (opt && opt.dataset && opt.dataset.provider && opt.dataset.model) {
      return { provider: opt.dataset.provider, model: opt.dataset.model };
    }
    if (MODELS[0]) return { provider: MODELS[0].provider, model: MODELS[0].model };
    return null;
  }

  function renderChrome() {
    var autoplayOn = document.body.classList.contains("is-autoplay");
    var btnAutoplay = document.getElementById("btnAutoplay");
    if (btnAutoplay) btnAutoplay.disabled = busy;
    if (!autoplayOn) return false;
    railFor({ kind: "step", round: boardRound || Math.max(1, history.length + 1), stepIdx: boardStepIdx });
    var more = !!nextAutoplayRound();
    btnBack.disabled = true;
    btnNext.disabled = busy;
    btnNext.textContent = busy ? "Working…" : (more ? "Next turn ›" : "Finish ›");
    hintEl.textContent = busy
      ? "Autoplay: one turn — Look, Decide, Do, Repeat, then pause"
      : (more
        ? "Paused — Next or Autoplay starts the next turn"
        : "Every DOD row is done — Next to finish");
    return true;
  }

  function render() {
    if (renderChrome()) return;
    clearTypers();
    var f = frames[pos];
    if (!f) return;
    stage.innerHTML = f.html;
    railFor(f.meta);
    btnBack.disabled = pos === 0 || busy;
    var plan = plannedNext();
    if (busy) { btnNext.disabled = true; btnNext.textContent = "Working…"; }
    else if (plan) {
      var onFiles = f.meta && f.meta.kind === "files";
      btnNext.disabled = false;
      btnNext.textContent = (onFiles ? "Begin" : plan.label) + " ›";
    }
    else { btnNext.disabled = false; btnNext.textContent = "Restart ↻"; }
    hintEl.textContent = pos === 0 ? "Space or → to go forward · settings to pick a model" : "Space or → forward · ← back";
    runTypewriter();
  }

  function runTypewriter() {
    var els = stage.querySelectorAll("[data-tw]");
    if (!els.length) return;
    Array.prototype.forEach.call(els, function (el) {
      var full = audience(b64dec(el.getAttribute("data-tw")));
      var key = el.getAttribute("data-twk") || ("p" + pos);
      var caret = '<span class="tw-caret">▋</span>';
      var show = function (n) { el.innerHTML = decorateMoneyHtml(esc(full.slice(0, n))) + caret; el.scrollTop = el.scrollHeight; };
      var finish = function () { if (el._iv) { clearInterval(el._iv); el._iv = null; } el.innerHTML = decorateMoneyHtml(esc(full)); typedKeys.add(key); };
      el.style.cursor = "pointer";
      el.onclick = finish;
      if (typedKeys.has(key) || !full) { finish(); return; }
      var dur = Math.min(9000, 900 + full.length * 18), start = Date.now();
      show(0);
      el._iv = setInterval(function () {
        var p = (Date.now() - start) / dur;
        if (p >= 1) { finish(); return; }
        show(Math.max(1, Math.round(full.length * p)));
      }, 16);
      typers.push(el._iv);
    });
  }
  function plannedNext() {
    if (pos < frames.length - 1) return { label: labelFor(frames[pos + 1].meta) };
    if (pending) return { label: labelFor(pending) };
    return null;
  }
  function labelFor(m) {
    if (!m) return "Restart";
    if (m.kind === "intro") return "See the files";
    if (m.kind === "files") return "See the files";
    if (m.kind === "outro") return "Finish";
    return STEPS[m.stepIdx].plain;
  }

  function paneChromeHtml() {
    return '<div class="board-tabs" role="tablist">' +
      '<button type="button" class="board-tab on" data-tab="story" aria-selected="true">Story</button>' +
      '<button type="button" class="board-tab" data-tab="evidence" aria-selected="false">Evidence <span class="board-tab-n" hidden>0</span></button>' +
      "</div>" +
      '<div class="board-tab-panel on" data-panel="story"><p class="board-narrate" data-log="">Waiting for this turn…</p></div>' +
      '<div class="board-tab-panel" data-panel="evidence" hidden><div class="board-evi-list"></div></div>';
  }
  function resetBoardPanes() {
    ["read", "eval", "print", "loop"].forEach(function (id) {
      fillPane(id, paneChromeHtml(), "wait");
    });
    fillBoardDod(lastDod);
  }
  function fillPane(stepId, html, state) {
    var pane = document.getElementById("board-pane-" + stepId);
    var body = document.getElementById("board-body-" + stepId);
    if (pane) {
      pane.setAttribute("data-state", state || "wait");
      pane.style.setProperty("--pc", PC[{ read: 0, eval: 1, print: 2, loop: 3 }[stepId] || 0]);
    }
    if (body) body.innerHTML = html;
  }
  function showPaneTab(stepId, tab) {
    var body = document.getElementById("board-body-" + stepId);
    if (!body) return;
    Array.prototype.forEach.call(body.querySelectorAll(".board-tab"), function (btn) {
      var on = btn.getAttribute("data-tab") === tab;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    Array.prototype.forEach.call(body.querySelectorAll(".board-tab-panel"), function (panel) {
      var on = panel.getAttribute("data-panel") === tab;
      panel.hidden = !on;
      panel.classList.toggle("on", on);
    });
  }
  function markEvidenceCount(body) {
    if (!body) return;
    var n = body.querySelectorAll(".board-evi-list .board-evidence").length;
    var badge = body.querySelector(".board-tab-n");
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = n === 0;
    }
    var eviTab = body.querySelector('.board-tab[data-tab="evidence"]');
    if (eviTab && n) {
      eviTab.classList.add("has-new");
      setTimeout(function () { eviTab.classList.remove("has-new"); }, 1600);
    }
  }

  function fillBoardDod(dod) {
    var el = document.getElementById("boardDod");
    if (!el) return;
    if (dod && typeof renderDodRegistry === "function") el.innerHTML = renderDodRegistry(dod);
  }

  function typeIn(root) {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function () {
        if (settled) return;
        settled = true;
        resolve();
      };
      var els = root ? root.querySelectorAll("[data-tw]") : [];
      if (!els.length) { done(); return; }
      var left = els.length;
      var watchdog = setTimeout(function () {
        Array.prototype.forEach.call(els, function (el) {
          if (el._iv) { clearInterval(el._iv); el._iv = null; }
          el.innerHTML = esc(audience(b64dec(el.getAttribute("data-tw"))));
        });
        done();
      }, 18000);
      Array.prototype.forEach.call(els, function (el) {
        var full = audience(b64dec(el.getAttribute("data-tw")));
        var caret = '<span class="tw-caret">▋</span>';
        var finished = false;
        var show = function (n) { el.innerHTML = esc(full.slice(0, n)) + caret; };
        var finish = function () {
          if (finished) return;
          finished = true;
          if (el._iv) { clearInterval(el._iv); el._iv = null; }
          el.innerHTML = esc(full);
          left -= 1;
          if (left <= 0) { clearTimeout(watchdog); done(); }
        };
        el.style.cursor = "pointer";
        el.onclick = finish;
        if (!full) { finish(); return; }
        var dur = Math.min(12000, 1400 + full.length * 36);
        var start = Date.now();
        show(0);
        el._iv = setInterval(function () {
          var p = (Date.now() - start) / dur;
          if (p >= 1) { finish(); return; }
          show(Math.max(1, Math.round(full.length * p)));
        }, 16);
        typers.push(el._iv);
      });
    });
  }

  function vendorName(provider) {
    var p = String(provider || "").toLowerCase();
    if (p === "openai") return "ChatGPT";
    if (p === "anthropic") return "Claude";
    if (p === "google" || p === "gemini") return "Gemini";
    if (p === "mistral") return "Mistral";
    return provider || "the model";
  }
  function friendlyModel(m) {
    if (!m) return "the model";
    var label = modelLabelFor(m.model);
    var vendor = vendorName(m.provider);
    if (label && label.toLowerCase().indexOf(vendor.toLowerCase()) >= 0) return label;
    return vendor + " · " + label;
  }
  function compareCandidates(primary) {
    var rank = { anthropic: 0, openai: 1, gemini: 2, google: 2 };
    var rest = MODELS.filter(function (m) {
      if (!primary) return true;
      return !(m.model === primary.model && m.provider === primary.provider);
    });
    rest.sort(function (a, b) {
      var pa = Object.prototype.hasOwnProperty.call(rank, a.provider) ? rank[a.provider] : 8;
      var pb = Object.prototype.hasOwnProperty.call(rank, b.provider) ? rank[b.provider] : 8;
      return pa - pb;
    });
    return rest.slice(0, 2).map(function (m) { return { provider: m.provider, model: m.model }; });
  }
  function packEvalRun(model, ev) {
    var cmd = (ev.command || "").trim();
    var reasoning = (ev.parsed && ev.parsed.reasoning) || splitReasoning(ev.llm_response, cmd);
    return {
      provider: model.provider,
      model: model.model,
      name: modelLabelFor(model.model),
      usage: ev.usage || {},
      cost_usd: ev.usage && ev.usage.estimated_cost != null ? Number(ev.usage.estimated_cost) : 0,
      tokens: ev.usage && ev.usage.total_tokens != null ? Number(ev.usage.total_tokens) : 0,
      reasoning: audience(reasoning),
      command: cmd,
      finding: audience((ev.parsed && ev.parsed.finding) || ""),
      parsed: ev.parsed || {}
    };
  }
  function pickCheaper(runs) {
    if (!runs.length) return { idx: -1, why: "No model returned a command." };
    if (runs.length === 1) {
      return { idx: 0, why: "Only one model is configured, so I am using " + runs[0].name + "." };
    }
    var a = runs[0], b = runs[1];
    var ca = runUsd(a), cb = runUsd(b);
    var same = normCmd(a.command) === normCmd(b.command);
    if (cb < ca) {
      return {
        idx: 1,
        why: same
          ? (b.name + " was cheaper (" + usdLabel(cb) + " vs " + usdLabel(ca) + ") and gave the same command, so I am using " + b.name + ".")
          : (a.name + " wants " + truncate(a.command, 72) + " for " + usdLabel(ca) + ". " + b.name + " wants " + truncate(b.command, 72) + " for " + usdLabel(cb) + ". I am using " + b.name + " because it was cheaper.")
      };
    }
    if (ca < cb) {
      return {
        idx: 0,
        why: same
          ? (a.name + " was cheaper (" + usdLabel(ca) + " vs " + usdLabel(cb) + ") and gave the same command, so I am using " + a.name + ".")
          : (a.name + " wants " + truncate(a.command, 72) + " for " + usdLabel(ca) + ". " + b.name + " wants " + truncate(b.command, 72) + " for " + usdLabel(cb) + ". I am using " + a.name + " because it was cheaper.")
      };
    }
    return { idx: 0, why: "Both cost " + usdLabel(ca) + ". I am keeping " + a.name + ", the first call." };
  }
  function compareEvidence(runs) {
    return runs.map(function (r, i) {
      var prior = i > 0 ? runUsd(runs[i - 1]) : null;
      var vs = costVsLabel(costVsKind(runUsd(r), prior), prior);
      return r.name + "\nCOST: " + callCostLine(r) + (vs ? " — " + vs : "") + "\nCOMMAND: " + (r.command || "(no command)");
    }).join("\n\n");
  }
  function dodTalk(dod) {
    if (!dod) return "I do not have a DOD yet. DOD means Definition of Done — the checklist of what I am set to complete.";
    if (dod.complete) return "Every DOD row is already checked. There is nothing left to complete.";
    var n = dod.next || {};
    return "DOD means Definition of Done — the checklist of what I am set to complete. This turn I am set to complete " + (n.id || "the next row") + " — " + (n.title || "keep going") + ".";
  }
  function dodTalkShort(dod) {
    if (!dod) return "I still do not have a DOD list.";
    if (dod.complete) return "Every DOD row is already checked.";
    var n = dod.next || {};
    return "This turn I am set to complete " + (n.id || "the next row") + " — " + (n.title || "keep going") + ".";
  }
  function dodList(dod) {
    if (!dod || !dod.rows || !dod.rows.length) return "";
    return dod.rows.map(function (r) {
      return (r.status === "checked" ? "[x] " : "[ ] ") + r.id + " — " + r.title;
    }).join("\n");
  }

  function upsertEvidence(body, evidence, evidenceLabel) {
    if (!body || evidence == null || !String(evidence).trim()) return;
    var list = body.querySelector(".board-evi-list");
    if (!list) {
      list = document.createElement("div");
      list.className = "board-evi-list";
      var panel = body.querySelector('[data-panel="evidence"]');
      if (panel) panel.appendChild(list);
      else body.appendChild(list);
    }
    var cap = evidenceLabel || "Evidence";
    var boxes = list.querySelectorAll(".board-evidence");
    var existing = null;
    Array.prototype.forEach.call(boxes, function (box) {
      var c = box.querySelector(".board-evi-cap");
      if (c && c.textContent === cap) existing = box;
    });
    var html = '<span class="board-evi-cap">' + esc(cap) + "</span>" +
      '<pre class="board-out">' + esc(clipEvidence(evidence, 1400)) + "</pre>";
    if (existing) {
      existing.innerHTML = html;
    } else {
      var box = document.createElement("div");
      box.className = "board-evidence";
      box.innerHTML = html;
      list.appendChild(box);
      existing = box;
    }
    markEvidenceCount(body);
    existing.scrollTop = 0;
    list.scrollTop = list.scrollHeight;
  }

  function typeAppend(el, prior, full) {
    return new Promise(function (resolve) {
      var settled = false;
      var iv = null;
      var watchdog = null;
      var done = function () {
        if (settled) return;
        settled = true;
        if (iv) { clearInterval(iv); iv = null; }
        if (watchdog) clearTimeout(watchdog);
        el.innerHTML = esc(full);
        el.scrollTop = 0;
        resolve();
      };
      var startAt = Math.min((prior || "").length, full.length);
      if (startAt >= full.length) { done(); return; }
      var caret = '<span class="tw-caret">▋</span>';
      var show = function (n) {
        el.innerHTML = esc(full.slice(0, n)) + caret;
        el.scrollTop = el.scrollHeight;
      };
      var dur = Math.min(14000, 1600 + (full.length - startAt) * 40);
      var t0 = Date.now();
      show(Math.max(startAt, 1));
      iv = setInterval(function () {
        var p = (Date.now() - t0) / dur;
        if (p >= 1) { done(); return; }
        show(startAt + Math.max(1, Math.round((full.length - startAt) * p)));
      }, 32);
      typers.push(iv);
      el.style.cursor = "pointer";
      el.onclick = done;
      watchdog = setTimeout(done, 18000);
    });
  }

  function narratePane(stepId, narrate, evidence, evidenceLabel, state) {
    var pane = document.getElementById("board-pane-" + stepId);
    var body = document.getElementById("board-body-" + stepId);
    if (pane) {
      pane.setAttribute("data-state", state || "wait");
      pane.style.setProperty("--pc", PC[{ read: 0, eval: 1, print: 2, loop: 3 }[stepId] || 0]);
    }
    if (!body) return Promise.resolve();
    if (!body.querySelector(".board-tabs")) body.innerHTML = paneChromeHtml();
    showPaneTab(stepId, "story");
    var story = body.querySelector('[data-panel="story"]') || body;
    var el = story.querySelector(".board-narrate");
    if (!el) {
      el = document.createElement("p");
      el.className = "board-narrate";
      el.setAttribute("data-log", "");
      story.insertBefore(el, story.firstChild);
    }
    var add = String(narrate || "").trim();
    var rawPrior = el.getAttribute("data-log") || "";
    var shown = (el.textContent || "").replace(/\s*▋\s*$/, "").trim();
    if (shown === "Waiting…" || shown === "Waiting for this turn…") shown = "";
    var prior = rawPrior || shown;
    if (prior === "Waiting…" || prior === "Waiting for this turn…") prior = "";
    var full = add ? (prior ? prior.replace(/\s+$/, "") + "\n\n" + add : add) : prior;
    el.setAttribute("data-log", full);
    return typeAppend(el, prior, full).then(function () {
      upsertEvidence(body, evidence, evidenceLabel);
    });
  }

  function fillZapStrip() {
    var el = document.getElementById("boardZapOut");
    if (el) el.textContent = ZAP_RESULTS;
  }
  function enterBoard(round) {
    var board = document.getElementById("execution-board");
    if (board) board.classList.add("execution-board");
    document.body.classList.add("is-autoplay");
    boardRound = round;
    boardStepIdx = 0;
    fillZapStrip();
    lastShownCost = null;
    lastCostCompare = { kind: "", text: "", n: 0 };
    resetBoardPanes();
  }

  function leaveBoard() {
    document.body.classList.remove("is-autoplay");
  }

  function nextAutoplayRound() {
    if (finding || (lastDod && lastDod.complete)) return 0;
    var round = history.length + 1;
    if (round > MAX_TURNS) return 0;
    return round;
  }

  async function runAutoplay() {
    if (busy) return;
    var round = nextAutoplayRound();
    if (!round) {
      showToast(lastDod && lastDod.complete ? "Every DOD row is checked. Restart to run again." : "This demo has no more turns.");
      return;
    }
    var model = selectedModel();
    if (!model) {
      showToast("Pick a model in settings first.");
      return;
    }
    var gen = runGen;
    enterBoard(round);
    busy = true;
    renderChrome();
    try {
      boardStepIdx = 0;
      fillBoardDod(lastDod);
      await narratePane(
        "read",
        "I am reading the OWASP ZAP results. A ZAP scan already ran. I am not scanning anything live. " + (history.length ? dodTalkShort(lastDod) : dodTalk(lastDod)) + " I will only do that one job.",
        ZAP_RESULTS,
        "OWASP ZAP results",
        "run"
      );
      if (!stillCurrent(gen)) return;
      var readData = await apiPost("/api/step/read", { provider: model.provider, model: model.model, history: history });
      if (!stillCurrent(gen)) return;
      if (readData.dod) lastDod = readData.dod;
      rememberPrompt(readData);
      loopDraft = { turn: round, dod: readData.dod };
      fillBoardDod(lastDod);
      await narratePane(
        "read",
        "I finished reading the OWASP ZAP results. " + dodTalkShort(lastDod) + " That is the only job this turn is allowed to do.",
        dodList(lastDod),
        "DOD — what I am set to complete",
        "done"
      );
      if (!stillCurrent(gen)) return;
      frames.push({ html: readScene(round, readData), meta: { kind: "step", round: round, stepIdx: 0 } });
      pos = frames.length - 1;

      boardStepIdx = 1;
      renderChrome();
      var firstName = friendlyModel(model);
      await narratePane(
        "eval",
        "I am deciding the next command. I will ask a language model — " + firstName + ".",
        "",
        "",
        "run"
      );
      if (!stillCurrent(gen)) return;
      evalRunsByRound[round] = [];
      var ev = await withLlmPulse(firstName, function () {
        return apiPost("/api/step/eval", { provider: model.provider, model: model.model, history: history });
      }, lastLlmPrompt);
      if (!stillCurrent(gen)) return;
      var runA = packEvalRun(model, ev);
      if (!runA.command) throw new Error("Model returned no command. Raw: " + truncate(ev.llm_response || "", 160));
      evalRunsByRound[round].push(runA);
      await narratePane(
        "eval",
        firstName + " answered. This call cost " + usdLabel(runUsd(runA)) + (lastCostCompare.text ? " — " + lastCostCompare.text : "") + ".",
        runA.command,
        firstName + " · cost " + usdLabel(runUsd(runA)),
        "run"
      );

      var candidates = compareCandidates(model);
      var runB = null;
      var cmpTried = null;
      var ci;
      for (ci = 0; ci < candidates.length && !runB; ci++) {
        cmpTried = candidates[ci];
        await narratePane(
          "eval",
          "I have " + runA.name + "'s command. I am asking a second model so we can compare cost — " + friendlyModel(cmpTried) + ".",
          runA.command,
          runA.name + " · " + callCostLine(runA),
          "run"
        );
        if (!stillCurrent(gen)) return;
        try {
          var evB = await withLlmPulse(friendlyModel(cmpTried), function () {
            return apiPost("/api/step/eval", { provider: cmpTried.provider, model: cmpTried.model, history: history });
          }, lastLlmPrompt);
          if (!stillCurrent(gen)) return;
          runB = packEvalRun(cmpTried, evB);
          if (runB.command) {
            evalRunsByRound[round].push(runB);
            await narratePane(
              "eval",
              friendlyModel(cmpTried) + " answered. This call cost " + usdLabel(runUsd(runB)) + (lastCostCompare.text ? " — " + lastCostCompare.text : "") + ".",
              runB.command,
              friendlyModel(cmpTried) + " · cost " + usdLabel(runUsd(runB)),
              "run"
            );
          } else runB = null;
        } catch (cmpErr) {
          runB = null;
        }
      }

      var pick = pickCheaper(evalRunsByRound[round]);
      var winner = evalRunsByRound[round][pick.idx] || runA;
      selectedRunByRound[round] = pick.idx < 0 ? 0 : pick.idx;
      var evalTalk;
      var evalEvidence = compareEvidence(evalRunsByRound[round]);
      var evalCap = "What the models returned";
      if (runB) {
        await narratePane(
          "eval",
          "I have two answers. I am sending both to a judge — a third language model that picks which command finishes this DOD row.",
          evalEvidence,
          "Both answers + cost",
          "run"
        );
        if (!stillCurrent(gen)) return;
        try {
          var judgeRes = await askJudge(evalRunsByRound[round]);
          if (!stillCurrent(gen)) return;
          judgeByRound[round] = judgeRes;
          var judged = normalizeJudge(judgeRes, evalRunsByRound[round]);
          selectedRunByRound[round] = judged.winnerIdx;
          winner = evalRunsByRound[round][judged.winnerIdx] || winner;
          evalTalk = "The judge picked " + winner.name + ". " + judged.why +
            " Costs: " + runA.name + " " + usdLabel(runUsd(runA)) +
            ", " + runB.name + " " + usdLabel(runUsd(runB)) +
            ", judge " + usdLabel(costFrom(judgeRes)) + ".";
          evalEvidence = judgeDecisionText(judgeRes, evalRunsByRound[round]);
          evalCap = "Judge’s decision";
        } catch (judgeErr) {
          evalTalk = "The judge did not answer. " + pick.why;
        }
      } else {
        evalTalk = cmpTried
          ? ("I called " + firstName + ". The second model did not answer, so I am using " + runA.name + ". That call cost " + usdLabel(runUsd(runA)) + ".")
          : ("I called " + firstName + ". No second model is available, so I am using that command. That call cost " + usdLabel(runUsd(runA)) + ".");
      }
      loopDraft.command = winner.command;
      loopDraft.parsed = winner.parsed || { command: winner.command, reasoning: winner.reasoning, finding: winner.finding || "" };
      await narratePane("eval", evalTalk, evalEvidence, evalCap, "done");
      if (!stillCurrent(gen)) return;
      frames.push({ html: evalScene(round), meta: { kind: "step", round: round, stepIdx: 1 } });
      pos = frames.length - 1;

      boardStepIdx = 2;
      renderChrome();
      var cmd = winner.command;
      var usedJudge = judgeByRound[round] && !judgeByRound[round].pending;
      await narratePane(
        "print",
        "I am doing the command " + (usedJudge ? "the judge picked" : "I picked") + ". Running it in the sandbox: " + cmd,
        cmd,
        "Command",
        "run"
      );
      if (!stillCurrent(gen)) return;
      var printed = await apiPost("/api/step/print", { command: cmd, parsed: loopDraft.parsed || {}, history: history });
      if (!stillCurrent(gen) || !loopDraft) return;
      loopDraft.stdout = printed.stdout;
      loopDraft.stderr = printed.stderr;
      loopDraft.printData = printed;
      if (printed.dod) lastDod = printed.dod;
      if ((printed.command || "").toUpperCase() === "EXIT") finding = findingTextFrom(printed);
      var out = (printed.stdout || "").trim();
      var err = (printed.stderr || printed.validation_error || "").trim();
      var printTalk = printed.validation_error
        ? ("The sandbox blocked that command. " + printed.validation_error)
        : ((printed.command || "").toUpperCase() === "EXIT"
          ? "I am done. Here is the finding from the OWASP ZAP work."
          : "Here is what that command printed.");
      fillBoardDod(lastDod);
      await narratePane("print", printTalk, out || err || "(no output)", "Output", "done");
      if (!stillCurrent(gen)) return;
      frames.push({ html: printScene(round, printed), meta: { kind: "step", round: round, stepIdx: 2 } });
      pos = frames.length - 1;

      boardStepIdx = 3;
      renderChrome();
      history.push({
        turn: loopDraft.turn,
        command: loopDraft.command,
        stdout: loopDraft.stdout,
        stderr: loopDraft.stderr || "",
        finding: (loopDraft.parsed && loopDraft.parsed.finding) || "",
        dod: loopDraft.printData && loopDraft.printData.dod
      });
      var pd = loopDraft.printData || {};
      var v = pd.dod && pd.dod.verification;
      var learned = (v && v.ok)
        ? (v.id + " passed. That DOD row is complete. " + (v.evidence || "Keep the result."))
        : (v && v.ok === false)
          ? ((v.id || "This DOD row") + " did not pass. " + (v.reason || "Try the same DOD row on the next turn."))
          : (out ? "I learned something from that output." : "That command returned nothing.");
      var more = round < MAX_TURNS && !finding && !(lastDod && lastDod.complete);
      var loopTalk = more
        ? (learned + " Ready for the next turn. I am pausing here.")
        : (learned + " Every DOD row that this demo needs can stop here. I am pausing.");
      fillBoardDod(lastDod);
      await narratePane("loop", loopTalk, (v && (v.evidence || v.reason)) || dodList(lastDod), "DOD check", "done");
      frames.push({ html: loopScene(round, pd), meta: { kind: "step", round: round, stepIdx: 3 } });
      pos = frames.length - 1;
      loopDraft = null;
      pending = more ? { kind: "step", round: round + 1, stepIdx: 0 } : { kind: "outro" };
    } catch (e) {
      if (!stillCurrent(gen)) return;
      showToast(e.message);
      await narratePane("loop", "This turn stopped: " + e.message + " I am pausing here.", "", "", "run");
    } finally {
      if (stillCurrent(gen)) { busy = false; renderChrome(); }
    }
  }

  async function goNext() {
    if (busy) return;
    if (document.body.classList.contains("is-autoplay")) {
      if (nextAutoplayRound()) {
        await runAutoplay();
        return;
      }
      leaveBoard();
      if (pending && pending.kind === "outro") {
        await runLive(pending);
        return;
      }
      if (frames.length) { pos = frames.length - 1; render(); return; }
      return;
    }
    if (pos < frames.length - 1) { pos++; render(); return; }
    if (!pending) { restart(); return; }
    await runLive(pending);
  }
  function goBack() { if (!busy && pos > 0) { pos--; render(); } }

  async function runLive(meta) {
    if (meta.kind === "intro") { pushFrame(introScene(), meta); pos = frames.length - 1; pending = { kind: "files" }; render(); return; }
    if (meta.kind === "files") { pushFrame(filesScene(), meta); pos = frames.length - 1; pending = { kind: "step", round: 1, stepIdx: 0 }; render(); return; }
    if (meta.kind === "outro") { pushFrame(outroScene(), meta); pos = frames.length - 1; pending = null; render(); return; }

    var round = meta.round, step = STEPS[meta.stepIdx].id;

    if (step === "read") {
      var gen = runGen;
      busy = true;
      pushFrame(thinkingScene(round, 0, "Reading the OWASP ZAP results…", "See this turn's DOD and the one finding."), meta);
      pos = frames.length - 1; render();
      try {
        var r = await apiPost("/api/step/read", payload());
        if (!stillCurrent(gen)) return;
        if (r.dod) lastDod = r.dod;
        rememberPrompt(r);
        loopDraft = { turn: round, dod: r.dod };
        frames[pos] = { html: readScene(round, r), meta: meta };
        pending = { kind: "step", round: round, stepIdx: 1 };
      } catch (e) {
        if (!stillCurrent(gen)) return;
        showToast(e.message);
        loopDraft = { turn: round };
        frames[pos] = { html: readScene(round), meta: meta };
        pending = { kind: "step", round: round, stepIdx: 1 };
      } finally { if (stillCurrent(gen)) { busy = false; render(); } }
      return;
    }
    if (step === "eval") {
      evalRunsByRound[round] = [];
      var opt = modelSelect.selectedOptions[0] || {}, d0 = opt.dataset || {};
      await runEvalModel(round, meta, d0.provider, d0.model, true);
      return;
    }
    if (step === "print") {
      var gen = runGen;
      var cmd = loopDraft && loopDraft.command;
      var parsed = (loopDraft && loopDraft.parsed) || {};
      busy = true;
      pushFrame(thinkingScene(round, 2, "Running that command…", truncate(cmd || "", 60)), meta);
      pos = frames.length - 1; render();
      try {
        var p = await apiPost("/api/step/print", { command: cmd, parsed: parsed, history: history });
        if (!stillCurrent(gen) || !loopDraft) return;
        loopDraft.stdout = p.stdout; loopDraft.stderr = p.stderr; loopDraft.printData = p;
        if (p.dod) lastDod = p.dod;
        if ((p.command || "").toUpperCase() === "EXIT") finding = findingTextFrom(p);
        frames[pos] = { html: printScene(round, p), meta: meta };
        pending = { kind: "step", round: round, stepIdx: 3 };
      } catch (e) {
        if (!stillCurrent(gen)) return;
        showToast(e.message); frames.pop(); pos = frames.length - 1;
      }
      finally { if (stillCurrent(gen)) { busy = false; render(); } }
      return;
    }
    if (step === "loop") {
      history.push({
        turn: loopDraft.turn,
        command: loopDraft.command,
        stdout: loopDraft.stdout,
        stderr: loopDraft.stderr || "",
        finding: (loopDraft.parsed && loopDraft.parsed.finding) || "",
        dod: loopDraft.printData && loopDraft.printData.dod
      });
      var pd = loopDraft.printData || {};
      pushFrame(loopScene(round, pd), meta); pos = frames.length - 1; loopDraft = null;
      if (round < MAX_TURNS && !finding && !(lastDod && lastDod.complete)) pending = { kind: "step", round: round + 1, stepIdx: 0 };
      else pending = { kind: "outro" };
      render(); return;
    }
  }

  async function runJudge(round, meta) {
    var runs = evalRunsByRound[round] || [];
    if (runs.length < 2 || busy) return;
    var gen = runGen;
    busy = true;
    judgeByRound[round] = { pending: true };
    frames[pos] = { html: evalScene(round), meta: meta }; render();
    try {
      var res = await askJudge(runs);
      if (!stillCurrent(gen)) return;
      judgeByRound[round] = res;
      frames[pos] = { html: evalScene(round), meta: meta };
    } catch (e) {
      if (!stillCurrent(gen)) return;
      showToast(e.message); delete judgeByRound[round]; frames[pos] = { html: evalScene(round), meta: meta };
    }
    finally { if (stillCurrent(gen)) { busy = false; render(); } }
  }

  function restart() {
    runGen += 1;
    history = []; loopDraft = null; frames = []; pos = 0; pending = null; finding = null; busy = false; lastDod = null;
    lastLlmPrompt = "";
    lastShownCost = null;
    lastCostCompare = { kind: "", text: "", n: 0 };
    boardRound = 0; boardStepIdx = 0;
    evalRunsByRound = {}; selectedRunByRound = {}; judgeByRound = {}; typedKeys = new Set();
    clearTypers();
    hideLlmPopup();
    leaveBoard();
    resetBoardPanes();
    fetch("/api/reset", { method: "POST" }).then(function (res) { return res.json(); }).then(function (d) {
      if (d && d.dod) lastDod = d.dod;
    }).catch(function () {});
    fetch("/api/dod").then(function (res) { return res.json(); }).then(function (d) { lastDod = d; }).catch(function () {});
    pushFrame(introScene(), { kind: "intro" }); pending = { kind: "files" }; render();
  }

  function ensureLoopDraft(round) {
    if (loopDraft && loopDraft.turn === round) return true;
    var runs = evalRunsByRound[round] || [];
    var idx = (round in selectedRunByRound) ? selectedRunByRound[round] : runs.length - 1;
    var chosen = runs[idx];
    if (!chosen) return false;
    loopDraft = {
      turn: round,
      command: chosen.command,
      parsed: { command: chosen.command, reasoning: chosen.reasoning, finding: chosen.finding || "" }
    };
    return true;
  }

  function resumeThisEval(meta) {
    if (!meta || meta.kind !== "step" || meta.stepIdx !== 1) return false;
    if (pos < frames.length - 1) {
      frames = frames.slice(0, pos + 1);
      pending = { kind: "step", round: meta.round, stepIdx: 2 };
    }
    while (history.length && history[history.length - 1].turn >= meta.round) history.pop();
    return ensureLoopDraft(meta.round);
  }

  stage.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    var meta = frames[pos] && frames[pos].meta;
    if (!meta || meta.kind !== "step" || busy) return;
    if (!e.target.closest('[data-act="run-model"], [data-act="judge"], [data-act="use-run"]')) return;
    if (!resumeThisEval(meta)) {
      showToast("Go back to Decide to compare models on the same DOD job.");
      return;
    }

    var runBtn = e.target.closest('[data-act="run-model"]');
    if (runBtn) {
      var sel = document.getElementById("cmpModel"), opt = sel && sel.selectedOptions[0];
      if (!opt) return;
      runEvalModel(meta.round, meta, opt.getAttribute("data-provider"), opt.value, false);
      return;
    }
    if (e.target.closest('[data-act="judge"]')) { runJudge(meta.round, meta); return; }
    var useBtn = e.target.closest('[data-act="use-run"]');
    if (useBtn) {
      var round = meta.round, idx = parseInt(useBtn.getAttribute("data-idx"), 10);
      var chosen = (evalRunsByRound[round] || [])[idx];
      if (!chosen || !loopDraft) return;
      selectedRunByRound[round] = idx;
      loopDraft.command = chosen.command;
      loopDraft.parsed = { command: chosen.command, reasoning: chosen.reasoning, finding: chosen.finding || "" };
      frames[pos] = { html: evalScene(round), meta: meta };
      render();
    }
  });

  function openModal() { modal.hidden = false; } function closeModal() { modal.hidden = true; }
  document.getElementById("btnSettings").addEventListener("click", openModal);
  document.getElementById("btnCloseSettings").addEventListener("click", closeModal);
  document.getElementById("btnReset").addEventListener("click", function () { closeModal(); restart(); });
  document.getElementById("btnRestartTop").addEventListener("click", restart);
  document.getElementById("btnAutoplay").addEventListener("click", runAutoplay);
  var boardEl = document.getElementById("execution-board");
  if (boardEl) {
    boardEl.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest && e.target.closest(".board-tab");
      if (!btn) return;
      var pane = btn.closest(".board-pane");
      var step = pane && pane.getAttribute("data-step");
      if (step) showPaneTab(step, btn.getAttribute("data-tab"));
    });
  }
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  btnNext.addEventListener("click", goNext);
  stage.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest('[data-act="autoplay"]')) {
      e.preventDefault();
      runAutoplay();
    }
  });
  btnBack.addEventListener("click", goBack);
  document.addEventListener("keydown", function (e) {
    if (!modal.hidden) { if (e.key === "Escape") closeModal(); return; }
    var t = e.target && e.target.tagName;
    if (t === "SELECT" || t === "INPUT" || t === "TEXTAREA") { return; }
    if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); goNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
    else if (e.key === "r" || e.key === "R") { restart(); }
  });

  async function init() {
    resetBoardPanes();
    pushFrame(introScene(), { kind: "intro" });
    pending = { kind: "files" };
    render();
    try {
      var res = await fetch("/api/models"), j = await res.json(), models = j.models || [];
      MODELS = models;
      modelSelect.innerHTML = models.map(function (m) {
        var label = window.formatModelLabel ? window.formatModelLabel(m, models) : (m.label || m.model);
        return '<option data-provider="' + m.provider + '" data-model="' + m.model + '">' + label + "</option>";
      }).join("");
    } catch (e) { showToast("Could not load models: " + e.message); }
    try {
      lastDod = await (await fetch("/api/dod")).json();
    } catch (e) { lastDod = null; }
    if (frames[0] && frames[0].meta && frames[0].meta.kind === "intro") {
      frames[0] = { html: introScene(), meta: { kind: "intro" } };
      if (pos === 0) render();
    }
  }
  init();
})();
