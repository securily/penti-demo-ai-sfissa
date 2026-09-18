/** DoD registry + key-present flags for the Northstar CSP REPL. */
(function (global) {
  function moneyCopy(s) {
    var t = String(s == null ? "" : s);
    t = t.replace(/\$10,000/g, "\u0001").replace(/\$0\b/g, "\u0002");
    t = t.replace(/\b10[, ]?000\b/g, "\u0001");
    t = t.replace(/\bspent\s+0\b/gi, "spent \u0002");
    t = t.replace(/\bleft(?:over)?\s+0\b/gi, "leftover \u0002");
    return t.replace(/\u0001/g, "$10,000").replace(/\u0002/g, "$0");
  }

  function moneyHtml(s) {
    return escapeHtml(moneyCopy(s)).replace(/\$10,000|\$0\b/g, function (m) {
      var cls = "money" + (m === "$10,000" ? " leftover" : " zero");
      return '<span class="' + cls + '">' + m + "</span>";
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function rowState(row, nextId) {
    if (row.status === "checked") return "pass";
    if (row.last_attempt) return "fail";
    if (nextId && row.id === nextId) return "next";
    return "open";
  }

  function markFor(state) {
    if (state === "pass") return "✓";
    if (state === "fail") return "✗";
    if (state === "next") return "→";
    return "○";
  }

  function renderDodRegistry(dod, opts) {
    opts = opts || {};
    if (!dod || !dod.rows) return "";
    var nextId = dod.next && dod.next.id;
    var items = dod.rows
      .map(function (row) {
        var state = rowState(row, nextId);
        var extra = "";
        if (state === "pass" && row.evidence) {
          extra = '<span class="dod-evidence">' + moneyHtml(row.evidence) + "</span>";
        } else if (state === "fail" && row.last_attempt) {
          extra = '<span class="dod-evidence fail">' + moneyHtml(row.last_attempt) + "</span>";
        }
        return (
          '<li class="dod-row ' +
          state +
          '"><span class="dod-mark">' +
          markFor(state) +
          '</span><span class="dod-id">' +
          escapeHtml(row.id) +
          '</span><span class="dod-title">' +
          escapeHtml(row.title) +
          "</span>" +
          extra +
          "</li>"
        );
      })
      .join("");
    var heading = opts.heading === false ? "" : '<p class="dod-heading">DOD — what we are set to complete</p>';
    var note = "";
    if (dod.complete) {
      note = '<p class="dod-note pass">Every DOD row is checked.</p>';
    } else if (dod.verification && dod.verification.ok === false) {
      note = '<p class="dod-note fail">That DOD row did not pass — retry the same DOD id.</p>';
    } else if (dod.next) {
      note = '<p class="dod-note">This turn’s DOD: <strong>' + escapeHtml(dod.next.id) + "</strong></p>";
    }
    return heading + '<ol class="dod-registry">' + items + "</ol>" + note;
  }

  function shortDodTitle(row) {
    var t = String((row && row.title) || "");
    return t;
  }

  function renderKeyFlags(health) {
    var el = document.getElementById("keyFlags");
    if (!el) return;
    var keys = (health && health.keys) || {};
    var labels = [
      ["gemini", "Gemini"],
      ["openai", "OpenAI"],
      ["anthropic", "Anthropic"],
      ["cursor", "Cursor"],
    ];
    el.hidden = false;
    el.innerHTML =
      '<div class="ssm-key-group"><strong>Provider keys</strong><ul>' +
      labels
        .map(function (pair) {
          var present = Boolean(keys[pair[0]]);
          return (
            "<li>" +
            escapeHtml(pair[1]) +
            ": <code>" +
            (present ? "present" : "missing") +
            "</code></li>"
          );
        })
        .join("") +
      "</ul></div>";
  }

  function initKeyFlags() {
    fetch("/api/health")
      .then(function (res) {
        return res.json();
      })
      .then(renderKeyFlags)
      .catch(function () {});
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initKeyFlags);
    } else {
      initKeyFlags();
    }
  }

  global.renderDodRegistry = renderDodRegistry;
  global.shortDodTitle = shortDodTitle;
  global.renderKeyFlags = renderKeyFlags;
  global.formatModelLabel = function (m) {
    return String((m && (m.label || m.model)) || "")
      .replace(/\s*·\s*\d+\s+credits?/i, "")
      .replace(/\s*\(Recommended\)/i, "")
      .trim();
  };
})(typeof window !== "undefined" ? window : globalThis);
