/* Northstar CSP REPL — wizard walkthrough plus Autoplay one-screen board. */
(function () {
  "use strict";

  var MAX_TURNS = 4;
  var BOOKS = "scan/";
  var GOALS = [
    "DOD-01 — See the CSP finding",
    "DOD-02 — See the login handler",
    "DOD-03 — Write the CSP fix",
  ];
  var PC = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)"];
  var STEPS = [
    { id: "read", letter: "R", name: "Read", plain: "Look", verb: "Open the scan and see what is missing." },
    { id: "eval", letter: "E", name: "Eval", plain: "Decide", verb: "Pick the one next thing to do." },
    { id: "print", letter: "P", name: "Print", plain: "Do", verb: "Run that step and show what happened." },
    { id: "loop", letter: "↻", name: "Loop", plain: "Repeat", verb: "Keep the result and look again." },
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
  function showToast(m) { toast.textContent = m; toast.classList.add("show"); setTimeout(function () { toast.classList.remove("show"); }, 5000); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function payload() { var o = modelSelect.selectedOptions[0] || {}, d = o.dataset || {}; return { provider: d.provider, model: d.model, history: history }; }
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
    return '<svg class="loop-ring" viewBox="0 0 ' + size + " " + size + '" role="img" aria-label="Agentic loop">' + comet + nodes + "</svg>";
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
      { n: "01", label: "Scan already ran", value: "ZAP baseline", note: "The JSON file is the scan. Nothing is probed live.", tone: "" },
      { n: "02", label: "One finding", value: "CSP missing", note: "Plugin 10038 — Content-Security-Policy header not set.", tone: "" },
      { n: "03", label: "Where it hits", value: "/login", note: "Northstar’s sign-in page never sets the header.", tone: " bad" }
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
        '<figcaption class="sheet-cap">A scanner already ran. One header is missing. The agent reads the report, finds the code, and writes the fix.</figcaption>' +
      "</figure>";
    return '<section class="scene scene-center scene-problem"><div class="scene-center-inner">' +
      '<div class="problem">' +
      '<p class="wiz-kicker">/ Northstar · SFISSA Workshop #2 · Fri Sep 18, 2026</p>' +
      '<div class="accent-bar" aria-hidden="true"></div>' +
      '<h1 class="problem-title">/login is missing <span class="money leftover">Content-Security-Policy</span></h1>' +
      '<p class="problem-lede">Northstar already ran a canned OWASP ZAP baseline. One finding remains: the login page never sets Content-Security-Policy. Look, decide, do, repeat.</p>' +
      cards + sheet +
      '<p class="problem-ask">Read the report. Find the handler. Write fix/csp.py with CSP = default-src \'self\'.</p>' +
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
        name: "The scan",
        what: "A canned OWASP ZAP baseline. One alert.",
        info: "pluginid 10038 · CSP Header Not Set · /login",
        means: "The JSON file is the scan. The agent reads it first."
      },
      {
        n: "02",
        path: "app/login.py",
        name: "The login handler",
        what: "Northstar’s /login response.",
        info: "Content-Type and Cache-Control only. No Content-Security-Policy.",
        means: "This is the code that is missing the header."
      },
      {
        n: "03",
        path: "scan/GOAL.md",
        name: "The goal",
        what: "See the finding, see the code, write the fix.",
        info: "see-finding → see-code → write-fix",
        means: "One slice per loop. The next unchecked row is the only job."
      },
      {
        n: "04",
        path: "fix/csp.py",
        name: "The fix",
        what: "Not in the folder yet. The agent writes it.",
        info: "CSP = default-src 'self' on Content-Security-Policy",
        means: "When this file exists and sets that header, the finding is closed."
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
      '<p class="wiz-kicker">/ Working papers · scan/</p>' +
      '<div class="accent-bar" aria-hidden="true"></div>' +
      '<h1 class="problem-title">The files the agent will use</h1>' +
      '<p class="problem-lede">Three files are already in the folder. One is missing. That missing file is the fix.</p>' +
      cards +
      "</div></div></section>";
  }
  function readScene(round, data) {
    var prev = history[history.length - 1];
    var last = round === 1 ? "Nothing yet — this is the first round." : (prev && prev.stdout ? formatBooksOut(prev.stdout) : "(the previous command returned nothing)");
    var dod = (data && data.dod) || lastDod;
    var nextGoal = (dod && dod.next) ? (dod.next.id + " — " + dod.next.title) : (GOALS[round - 1] || "");
    var form = head(0, round) +
      '<div class="ctx-card">' +
      '<div class="ctx-row"><span class="ctx-k">Books</span><code class="ctx-v">' + esc(BOOKS) + "</code></div>" +
      '<div class="ctx-row"><span class="ctx-k">Last result</span><div class="ctx-v dim ctx-scroll" data-twk="r' + round + '-last" data-tw="' + b64enc(last) + '"></div></div>' +
      '<div class="ctx-row"><span class="ctx-k">DoD</span><span class="ctx-v">' + esc(nextGoal) + "</span></div></div>" +
      dodHtml(dod);
    var aside = '<p class="aside-title">The loop · round ' + round + " of " + MAX_TURNS + "</p>" + ring(0);
    return split(form, aside);
  }
  function thinkingScene(round, stepIdx, title, sub) {
    var form = head(stepIdx, round) +
      '<div class="thinking"><span class="think-orb" style="--pc:' + PC[stepIdx] + '"></span>' +
      '<div><p class="think-t">' + esc(title) + '</p><p class="think-s">' + esc(sub) + "</p></div>" +
      '<span class="think-dots"><i></i><i></i><i></i></span></div>';
    return split(form, '<p class="aside-title">The loop</p>' + ring(stepIdx));
  }
  function cmpControls(runs) {
    var used = {}; runs.forEach(function (r) { used[r.model] = 1; });
    var picked = false, opts = "";
    MODELS.forEach(function (m) {
      var sel = (!picked && !used[m.model]) ? " selected" : "";
      if (sel) picked = true;
      opts += '<option value="' + esc(m.model) + '" data-provider="' + esc(m.provider) + '"' + sel + '>' + esc(stripCredits(m.label || m.model)) + "</option>";
    });
    return '<div class="cmp-controls"><label class="cmp-label">Keep this — run another model to compare</label>' +
      '<div class="cmp-row"><select id="cmpModel" aria-label="Model to compare">' + opts + "</select>" +
      '<button type="button" class="cmp-run" data-act="run-model">Run and compare</button></div>' +
      '<p class="cmp-hint">Same step, same inputs — then both reasonings side by side.</p></div>';
  }

  function runCardHtml(r, baseCmd, isLatest, isSelected, idx, score, isWinner, round) {
    var diff = normCmd(r.command) !== normCmd(baseCmd);
    var action = isSelected
      ? '<span class="cmp-using">✓ Using this for Print</span>'
      : '<button type="button" class="cmp-use" data-act="use-run" data-idx="' + idx + '">Use this →</button>';
    var scoreBadge = (score != null && score > 0) ? '<span class="cmp-score">' + esc(String(score)) + '/10</span>' : "";
    var costBadge = '<span class="cmp-cost">' + esc(usdLabel(runUsd(r))) + "</span>";
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
        '<p class="eval-cost">This call · ' + esc(callCostLine(latest)) + "</p>" +
        '<div class="cmd-box"><span class="cmd-cap">Command the agent chose</span><code class="cmd-big" data-twk="r' + round + '-cmd-' + li + '" data-tw="' + b64enc(latest.command) + '"></code></div>' +
        cmpControls(runs);
      var aside = '<div class="reason-card"><p class="aside-title">Model reasoning</p><div class="aside-reasoning" data-twk="r' + round + '-reason-' + li + '" data-tw="' + b64enc(audience(latest.reasoning)) + '"></div></div>';
      return split(form, aside, "scene-eval");
    }

    var base = runs[0].command;
    var allSame = runs.every(function (r) { return normCmd(r.command) === normCmd(base); });
    var selIdx = (round in selectedRunByRound) ? selectedRunByRound[round] : runs.length - 1;
    var banner = '<div class="cmp-banner ' + (allSame ? "same" : "diff") + '">' +
      (allSame ? "All " + runs.length + " models chose the <b>same</b> command — they reason alike here"
               : "The models <b>diverged</b> — different commands for the same task") + "</div>";
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
      return '<aside class="judge-panel pending"><p class="judge-kicker">Judge’s verdict</p><p class="judge-why">Scoring the commands…</p></aside>';
    }
    if (!judge || !parsed) {
      return '<div class="judge-cta"><button type="button" class="judge-btn" data-act="judge">Judge these commands</button>' +
        '<span class="judge-cta-hint">A second model scores who is closest to closing the missing-header finding.</span></div>';
    }
    var pick = runs[parsed.winnerIdx] || {};
    var pickScore = parsed.scores[parsed.winnerIdx];
    var value = valueCallout(parsed, runs);
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
      (judge.judge_cost_usd != null ? ' · <span class="judge-model">' + esc(usdLabel(judge.judge_cost_usd)) + "</span>" : "") +
      "</p>" +
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
    var thinking = thinkingScene(round, 1, "Deciding the next step…", modelLabelFor(model));
    if (newFrame) { pushFrame(thinking, meta); pos = frames.length - 1; }
    else { frames[pos] = { html: thinking, meta: meta }; }
    render();
    try {
      var d = await apiPost("/api/step/eval", { provider: provider, model: model, history: history });
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
    if (isExit) learned = "The agent reported its finding and exited the loop.";
    else if (v && v.ok) learned = v.id + " passed. " + withDollars(v.evidence || "");
    else if (v && v.ok === false) learned = (v.id || "Slice") + " did not pass. " + withDollars(v.reason || "");
    else { var out = (data && data.stdout || "").trim(); learned = out ? "Learned: " + formatBooksOut(out) : "That command returned nothing — the next round tries a new angle."; }
    var dodDone = data && data.dod && data.dod.complete;
    var nextLine = (round < MAX_TURNS && !isExit && !dodDone) ? "Round " + (round + 1) + " starts again with Look." : "The work is done — the missing header has a fix.";
    var form = head(3, round) + '<div class="loop-focus"><div>' + ring(3) + '</div><div><p class="loop-learned" data-twk="r'+round+'-loop" data-tw="' + b64enc(learned) + '"></p><p class="loop-next">' + esc(nextLine) + "</p></div></div>" + dodHtml((data && data.dod) || lastDod);
    return '<section class="scene scene-center"><div class="scene-center-inner" style="max-width:760px">' + form + "</div></section>";
  }
  function outroScene() {
    var recap = history.map(function (h, i) { return '<li><span class="recap-n">' + (i + 1) + "</span><code>" + esc(h.command || "—") + "</code></li>"; }).join("");
    return center('<div class="hero"><div class="hero-ring">' + ring(-1) + "</div><div>" +
      '<p class="wiz-kicker">' + (lastDod && lastDod.complete ? "All DoD slices checked" : "Loop complete") + '</p><h1 class="hero-title">The loop <span>closed</span></h1>' +
      (finding ? '<div class="finding-banner"><span>FINDING</span><p data-twk="outro-finding" data-tw="' + b64enc(withDollars(finding)) + '"></p></div>'
        : '<p class="hero-lede">The missing-header finding is closed.</p>') +
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
  function render() {
    clearTypers();
    var autoplayOn = document.body.classList.contains("is-autoplay");
    var btnAutoplay = document.getElementById("btnAutoplay");
    if (btnAutoplay) btnAutoplay.disabled = busy;
    if (autoplayOn) {
      railFor({ kind: "step", round: boardRound || Math.max(1, history.length + 1), stepIdx: boardStepIdx });
      btnBack.disabled = busy;
      btnNext.disabled = busy;
      btnNext.textContent = busy ? "Working…" : "Next ›";
      hintEl.textContent = busy ? "Autoplay running this loop — all four beats stay on this screen" : "Autoplay idle — press again for the next loop · Next for walkthrough";
      return;
    }
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
    hintEl.textContent = pos === 0 ? "Space or → to advance · settings for model" : "Space / → forward · ← back";
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
      var dur = Math.min(2400, 320 + full.length * 5), start = Date.now();
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
    if (m.kind === "intro") return "The files";
    if (m.kind === "files") return "The files";
    if (m.kind === "outro") return "Finish";
    return STEPS[m.stepIdx].plain;
  }

  function resetBoardPanes() {
    ["read", "eval", "print", "loop"].forEach(function (id) {
      fillPane(id, '<p class="board-wait">Waiting…</p>', "wait");
    });
    var dodEl = document.getElementById("boardDod");
    if (dodEl) dodEl.innerHTML = lastDod && typeof renderDodRegistry === "function" ? renderDodRegistry(lastDod) : "";
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

  function fillBoardDod(dod) {
    var el = document.getElementById("boardDod");
    if (!el) return;
    if (dod && typeof renderDodRegistry === "function") el.innerHTML = renderDodRegistry(dod);
  }

  function enterBoard(round) {
    var board = document.getElementById("execution-board");
    if (board) board.classList.add("execution-board");
    document.body.classList.add("is-autoplay");
    boardRound = round;
    boardStepIdx = 0;
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
      showToast(lastDod && lastDod.complete ? "All slices are checked. Restart to run again." : "This demo has no more loops.");
      return;
    }
    var gen = runGen;
    enterBoard(round);
    busy = true;
    render();
    try {
      boardStepIdx = 0;
      fillPane("read", '<p class="board-wait">Looking at the scan…</p>', "run");
      fillBoardDod(lastDod);
      render();
      var readData = await apiPost("/api/step/read", payload());
      if (!stillCurrent(gen)) return;
      if (readData.dod) lastDod = readData.dod;
      loopDraft = { turn: round, dod: readData.dod };
      var nextGoal = (lastDod && lastDod.next) ? (lastDod.next.id + " — " + lastDod.next.title) : (GOALS[round - 1] || "");
      var last = history.length ? (history[history.length - 1].stdout || "(empty)") : "Nothing yet — this is the first round.";
      fillPane("read",
        '<p class="board-kicker">DoD</p><p class="board-reason">' + esc(nextGoal) + "</p>" +
        '<p class="board-kicker">Last result</p><pre class="board-out">' + esc(truncate(last, 400)) + "</pre>",
        "done");
      fillBoardDod(lastDod);
      frames.push({ html: readScene(round, readData), meta: { kind: "step", round: round, stepIdx: 0 } });
      pos = frames.length - 1;

      boardStepIdx = 1;
      fillPane("eval", '<p class="board-wait">Deciding the next step…</p>', "run");
      render();
      evalRunsByRound[round] = [];
      var opt = modelSelect.selectedOptions[0] || {}, d0 = opt.dataset || {};
      var ev = await apiPost("/api/step/eval", { provider: d0.provider, model: d0.model, history: history });
      if (!stillCurrent(gen)) return;
      var cmd = (ev.command || "").trim();
      if (!cmd) throw new Error("Model returned no command. Raw: " + truncate(ev.llm_response || "", 160));
      var reasoning = (ev.parsed && ev.parsed.reasoning) || splitReasoning(ev.llm_response, cmd);
      loopDraft.command = cmd;
      loopDraft.parsed = ev.parsed || {};
      (evalRunsByRound[round] = evalRunsByRound[round] || []).push({
        provider: d0.provider,
        model: d0.model,
        name: modelLabelFor(d0.model),
        usage: ev.usage || {},
        cost_usd: ev.usage && ev.usage.estimated_cost != null ? Number(ev.usage.estimated_cost) : 0,
        tokens: ev.usage && ev.usage.total_tokens != null ? Number(ev.usage.total_tokens) : 0,
        reasoning: audience(reasoning),
        command: cmd,
        finding: audience((ev.parsed && ev.parsed.finding) || "")
      });
      selectedRunByRound[round] = 0;
      fillPane("eval",
        '<p class="board-kicker">' + esc(modelLabelFor(d0.model)) + " · " + esc(callCostLine(evalRunsByRound[round][0])) + "</p>" +
        '<code class="board-cmd">' + esc(cmd) + "</code>" +
        '<p class="board-reason">' + esc(truncate(audience(reasoning), 500)) + "</p>",
        "done");
      frames.push({ html: evalScene(round), meta: { kind: "step", round: round, stepIdx: 1 } });
      pos = frames.length - 1;

      boardStepIdx = 2;
      fillPane("print", '<p class="board-wait">Doing that step…</p>', "run");
      render();
      var printed = await apiPost("/api/step/print", { command: cmd, parsed: loopDraft.parsed || {}, history: history });
      if (!stillCurrent(gen) || !loopDraft) return;
      loopDraft.stdout = printed.stdout;
      loopDraft.stderr = printed.stderr;
      loopDraft.printData = printed;
      if (printed.dod) lastDod = printed.dod;
      if ((printed.command || "").toUpperCase() === "EXIT") finding = findingTextFrom(printed);
      var out = (printed.stdout || "").trim();
      var err = (printed.stderr || printed.validation_error || "").trim();
      var printHtml = printed.validation_error
        ? '<pre class="board-out">Blocked: ' + esc(printed.validation_error) + "</pre>"
        : '<p class="board-kicker">' + esc(cmd) + "</p><pre class=\"board-out\">" +
          esc(out || err || "(no output)") + "</pre>";
      fillPane("print", printHtml, "done");
      fillBoardDod(lastDod);
      frames.push({ html: printScene(round, printed), meta: { kind: "step", round: round, stepIdx: 2 } });
      pos = frames.length - 1;

      boardStepIdx = 3;
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
      var learned = (v && v.ok) ? (v.id + " passed. " + (v.evidence || ""))
        : (v && v.ok === false) ? ((v.id || "Slice") + " did not pass. " + (v.reason || ""))
        : (out ? "Learned: " + truncate(out, 240) : "That command returned nothing.");
      fillPane("loop", '<p class="board-reason">' + esc(learned) + "</p>", "done");
      fillBoardDod(lastDod);
      frames.push({ html: loopScene(round, pd), meta: { kind: "step", round: round, stepIdx: 3 } });
      pos = frames.length - 1;
      loopDraft = null;
      if (round < MAX_TURNS && !finding && !(lastDod && lastDod.complete)) pending = { kind: "step", round: round + 1, stepIdx: 0 };
      else pending = { kind: "outro" };
    } catch (e) {
      if (!stillCurrent(gen)) return;
      showToast(e.message);
    } finally {
      if (stillCurrent(gen)) { busy = false; render(); }
    }
  }

  async function goNext() {
    if (busy) return;
    if (document.body.classList.contains("is-autoplay")) {
      leaveBoard();
      if (frames.length) { pos = frames.length - 1; render(); return; }
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
      pushFrame(thinkingScene(round, 0, "Looking at the scan…", "See the finding and this round's goal."), meta);
      pos = frames.length - 1; render();
      try {
        var r = await apiPost("/api/step/read", payload());
        if (!stillCurrent(gen)) return;
        if (r.dod) lastDod = r.dod;
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
      pushFrame(thinkingScene(round, 2, "Doing that step…", truncate(cmd || "", 60)), meta);
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
      var res = await apiPost("/api/judge", {
        candidates: runs.map(function (r) { return { label: r.name, command: r.command, reasoning: r.reasoning }; }),
        history: history
      });
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
    boardRound = 0; boardStepIdx = 0;
    evalRunsByRound = {}; selectedRunByRound = {}; judgeByRound = {}; typedKeys = new Set();
    clearTypers();
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
      showToast("Go back to Decide to compare models.");
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
