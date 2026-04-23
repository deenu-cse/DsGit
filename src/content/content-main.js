// ─── Content Script — DSA Tracker ────────────────────────────────────────────
// Platforms : LeetCode · GeeksForGeeks · CodingNinjas (Code360 on naukri.com)
//
// ARCHITECTURE:
//   • This script runs in the ISOLATED world (has chrome.* APIs, no window.monaco)
//   • bridge.js runs in the MAIN world (has window.monaco, no chrome.* APIs)
//   • They communicate via window.postMessage
//   • bridge.js is declared in manifest.json with "world": "MAIN" — this bypasses
//     any Content Security Policy (CSP) that sites like naukri.com enforce.
//     NEVER use s.textContent injection — naukri's CSP blocks it!

(function DSATrackerContent() {

  // ── Guard: don't run if context is already dead or already loaded ──────────
  if (window.__DSA_TRACKER_LOADED__) return;
  if (!chrome?.runtime?.id) {
    console.warn("[DSA Tracker] Extension context invalid on load — page needs refresh.");
    return;
  }
  window.__DSA_TRACKER_LOADED__ = true;

  const MAX_SNAPS = 10;
  const snapshots = [];    // in-memory ring buffer for current session
  let _pendingSubmission = null; // Stores all details when submit is clicked
  let _successTimer = null; // setInterval for success polling

  // ═══════════════════════════════════════════════════════════════════════════
  //  BRIDGE CALL — sends a message to bridge.js (MAIN world) via postMessage
  //  and waits for a reply. The bridge has direct access to window.monaco.
  //
  //  No injectBridge() needed! Chrome injects bridge.js automatically via
  //  manifest.json "world": "MAIN" content_script declaration.
  // ═══════════════════════════════════════════════════════════════════════════

  function bridgeCall(action, code) {
    return new Promise(resolve => {
      const id = "_dsa_" + Date.now() + Math.random().toString(36).slice(2, 6);
      let retries = 0;
      const maxRetries = 3;
      
      function attempt() {
        const tid = setTimeout(() => {
          window.removeEventListener("message", handler);
          if (retries < maxRetries && action === "get") {
            console.warn("[DSA Tracker] bridgeCall timeout for action:", action, "- retrying", retries + 1);
            retries++;
            setTimeout(attempt, 1000);
          } else {
            console.warn("[DSA Tracker] bridgeCall timeout for action:", action);
            resolve(null);
          }
        }, 4000); // 4s — enough for Monaco to initialize on slow pages

        function handler(e) {
          if (!e.data || e.data._t !== "dsa_pg" || e.data.id !== id) return;
          clearTimeout(tid);
          window.removeEventListener("message", handler);
          if (e.data.er) {
            console.error("[DSA Tracker] Bridge error:", e.data.er);
            if (retries < maxRetries && action === "get") {
              console.warn("[DSA Tracker] Retrying bridge call:", retries + 1);
              retries++;
              setTimeout(attempt, 500);
            } else {
              resolve(null);
            }
          } else {
            resolve(e.data.r ?? null);
          }
        }

        window.addEventListener("message", handler);
        window.postMessage({ _t: "dsa_cs", id, a: action, c: code ?? null }, "*");
      }
      
      attempt();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SAFE CHROME MESSAGE — catches "Extension context invalidated"
  // ═══════════════════════════════════════════════════════════════════════════

  async function safeMessage(msg) {
    try {
      if (!chrome?.runtime?.id) throw new Error("Extension context invalidated.");
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      const t = err?.message ?? "";
      if (
        t.includes("context invalidated") ||
        t.includes("Could not establish connection") ||
        t.includes("receiving end does not exist")
      ) {
        showToast(
          "🔄 <b>Extension reloaded.</b><br><small>Please refresh this page (F5) to reconnect.</small>",
          "warning"
        );
        return null;
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CODE SANITIZER — strips \u00a0 (non-breaking space = "?" bug)
  // ═══════════════════════════════════════════════════════════════════════════

  function sanitizeCode(code) {
    if (!code) return code;
    return code
      .replace(/\u00a0/g, " ")
      .replace(/\u200b/g, "")
      .replace(/\u00ad/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PLATFORM DEFINITIONS
  // ═══════════════════════════════════════════════════════════════════════════

  const PLATFORMS = [

    // ── LeetCode ──────────────────────────────────────────────────────────────
    {
      id: "LeetCode",
      pattern: /leetcode\.com\/problems\//,
      editorType: "monaco",

      isSubmitBtn(btn) {
        return (
          btn.matches?.('[data-e2e-locator="console-submit-button"]') ||
          /^submit$/i.test(btn.textContent?.trim())
        );
      },
      isSuccess() {
        const el = document.querySelector('[data-e2e-locator="submission-result"]');
        return el?.textContent?.trim().toLowerCase() === "accepted";
      },
      getDifficulty() {
        for (const sel of [
          '[class*="text-difficulty-easy"]', '[class*="text-difficulty-medium"]',
          '[class*="text-difficulty-hard"]', '[class*="difficulty"]',
        ]) {
          const m = document.querySelector(sel)?.textContent?.trim().match(/(easy|medium|hard|moderate)/i);
          if (m) {
            if (m[0].toLowerCase() === 'moderate') return 'Medium';
            return cap(m[0]);
          }
        }
        return null;
      },
      getQuestionName() {
        return (
          document.querySelector('[data-cy="question-title"]')?.textContent?.trim() ??
          extractFromTitle()
        );
      },
      getLang() {
        return (
          document.querySelector('[class*="Select__single-value"]')?.textContent?.trim() ??
          document.querySelector('[id*="headlessui-listbox-button"] span')?.textContent?.trim() ??
          ""
        );
      },
    },

    // ── GeeksForGeeks ─────────────────────────────────────────────────────────
    {
      id: "GeeksForGeeks",
      pattern: /geeksforgeeks\.org\/problems\//,
      editorType: "codemirror",

      isSubmitBtn(btn) { return /^submit$/i.test(btn.textContent?.trim()); },
      isSuccess() {
        const v =
          document.querySelector('[class*="verdict"]') ??
          document.querySelector('[class*="result_box"]') ??
          document.querySelector('[class*="Result"]');
        return v ? /correct|accepted|passed/i.test(v.textContent) : false;
      },
      getDifficulty() {
        const m = document.querySelector('[class*="difficulty"]')?.textContent?.trim().match(/(easy|medium|hard|moderate)/i);
        if (!m) return null;
        if (m[0].toLowerCase() === 'moderate') return 'Medium';
        return cap(m[0]);
      },
      getQuestionName() {
        return (
          document.querySelector('[class*="problems-title"]')?.textContent?.trim() ??
          document.querySelector('h1[class*="problem"]')?.textContent?.trim() ??
          extractFromTitle()
        );
      },
      getLang() {
        return document.getElementById("languageDropdown")?.value ??
          document.querySelector('[class*="langDropdown"]')?.value ?? "";
      },
    },

    // ── CodingNinjas / Code360 ────────────────────────────────────────────────
    {
      id: "CodingNinjas",
      pattern: /naukri\.com\/code360\/problems\//,
      editorType: "monaco",

      isSubmitBtn(btn) {
        const t = btn.textContent?.trim().toLowerCase() ?? "";
        return !!t && t.startsWith("submit") && !/sample|run|test/i.test(t);
      },
      isSuccess() {
        // Code360 shows "Accepted" as a text node inside various elements.
        // Scan leaf elements for exact match.
        const els = document.querySelectorAll(
          "h1,h2,h3,h4,h5,h6,p,span,div,[class*='status'],[class*='verdict'],[class*='result']"
        );
        for (const el of els) {
          if (el.children.length === 0 && el.textContent.trim() === "Accepted") return true;
        }
        return false;
      },
      getDifficulty() {
        const m = (
          document.querySelector('[class*="difficulty"]') ??
          document.querySelector('[class*="level"]')
        )?.textContent?.trim().match(/(easy|medium|hard|moderate)/i);
        if (!m) return null;
        if (m[0].toLowerCase() === 'moderate') return 'Medium';
        return cap(m[0]);
      },
      getQuestionName() {
        return (
          document.querySelector('h1[class*="problem"]')?.textContent?.trim() ??
          document.querySelector('[class*="problem-title"]')?.textContent?.trim() ??
          document.querySelector('[class*="problemTitle"]')?.textContent?.trim() ??
          extractFromTitle()
        );
      },
      getLang() {
        return (
          document.querySelector('[class*="language-name"]')?.textContent?.trim() ??
          document.querySelector('[class*="languageName"]')?.textContent?.trim() ??
          document.querySelector('[class*="selected-lang"]')?.textContent?.trim() ??
          ""
        );
      },
    },
  ];

  const platform = PLATFORMS.find(p => p.pattern.test(location.href));
  if (!platform) {
    console.log("[DSA Tracker] No platform matched:", location.href);
    return;
  }
  console.log("[DSA Tracker] ✅ Platform:", platform.id, "| URL:", location.href);

  // ═══════════════════════════════════════════════════════════════════════════
  //  GET CODE
  // ═══════════════════════════════════════════════════════════════════════════

  async function getCode() {
    if (platform.editorType === "monaco") {
      let code = await bridgeCall("get");
      if (code?.trim()) {
        return sanitizeCode(code);
      }

      console.warn("[DSA Tracker] Bridge failed. Falling back to DOM extraction...");

      // Fallback: Code360 / Monaco DOM extraction
      let domCode = "";
      const lines = document.querySelectorAll(".view-lines .view-line");
      if (lines.length > 0) {
        let lastTop = -1;
        lines.forEach(el => {
          const top = parseInt(el.style.top || '0');
          if (top !== lastTop) {
            if (lastTop !== -1) domCode += "\n";
            lastTop = top;
          }
          domCode += el.textContent;
        });
        if (domCode.trim()) return sanitizeCode(domCode);
      }

      console.warn("[DSA Tracker] DOM extraction also failed.");
      return null;
    }

    if (platform.editorType === "codemirror") {
      try {
        const code = document.querySelector(".CodeMirror")?.CodeMirror?.getValue?.() ?? null;
        if (code?.trim()) return sanitizeCode(code);
      } catch (_) { }
      return null;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SET CODE
  // ═══════════════════════════════════════════════════════════════════════════

  async function setCode(code) {
    if (!code) return false;
    const clean = sanitizeCode(code);

    if (platform.editorType === "monaco") {
      const ok = await bridgeCall("set", clean);
      if (ok) { console.log("[DSA Tracker] setCode: OK via bridge"); return true; }

      console.warn("[DSA Tracker] Bridge setCode failed. Attempting DOM event fallback.");

      // DOM Fallback for setting code (Simulate paste)
      const input = document.querySelector(".monaco-editor textarea");
      if (input) {
        input.focus();
        input.select();
        const success = document.execCommand('insertText', false, clean);
        if (success) {
          console.log("[DSA Tracker] setCode: OK via execCommand");
          return true;
        }
      }
      return false;
    }

    if (platform.editorType === "codemirror") {
      try {
        const cm = document.querySelector(".CodeMirror")?.CodeMirror;
        if (cm) { cm.setValue(clean); return true; }
      } catch (_) { }
      return false;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LANGUAGE / METADATA
  // ═══════════════════════════════════════════════════════════════════════════

  function getLanguage() {
    const raw = platform.getLang?.() ?? "";
    if (raw) { const n = normLang(raw); if (n !== "txt") return n; }
    for (const sel of ['[class*="Select__single-value"]', "#languageDropdown", 'select[name="language"]']) {
      const v = document.querySelector(sel)?.textContent?.trim() ?? document.querySelector(sel)?.value;
      if (v) { const n = normLang(v); if (n !== "txt") return n; }
    }
    return "cpp";
  }

  function normLang(raw) {
    const r = (raw ?? "").toLowerCase().replace(/\s*\(.*?\)/g, "").replace(/\s+/g, "").trim();
    const MAP = {
      python3: "python", py: "python", python: "python",
      java: "java",
      javascript: "javascript", js: "javascript",
      typescript: "typescript", ts: "typescript",
      "c++": "cpp", cpp: "cpp",
      "c++11": "cpp", "c++14": "cpp", "c++17": "cpp", "c++20": "cpp",
      "g++11": "cpp", "g++14": "cpp", "g++17": "cpp",
      c: "c",
      go: "go", golang: "go",
      rust: "rust", rs: "rust",
      kotlin: "kotlin", kt: "kotlin",
      swift: "swift",
      "c#": "csharp", csharp: "csharp",
      scala: "scala", php: "php", ruby: "ruby",
    };
    return MAP[r] ?? "txt";
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ""; }

  function getQuestionName() {
    const n = platform.getQuestionName?.();
    return (n && n !== "Unknown Question") ? n : extractFromTitle();
  }

  function extractFromTitle() {
    return (
      document.title
        .split(/\s*[-|–—]\s*/)
        .find(s => s.trim() && !/(leetcode|geeksforgeeks|gfg|coding ninjas|naukri|practice|problem|code360)/i.test(s))
        ?.trim() ?? "Unknown Question"
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SNAPSHOTS (Time Machine)
  // ═══════════════════════════════════════════════════════════════════════════

  async function takeSnapshot() {
    const code = await getCode();
    if (!code?.trim()) return;
    const snap = { code, savedAt: Date.now(), url: location.href };
    snapshots.unshift(snap);
    if (snapshots.length > MAX_SNAPS) snapshots.length = MAX_SNAPS;
    console.log("[DSA Tracker] 📸 Snapshot saved:", code.length, "chars");
    safeMessage({ type: "SAVE_SNAPSHOT", payload: { code, url: location.href } }).catch(() => { });
  }

  setInterval(takeSnapshot, 30_000);
  setTimeout(takeSnapshot, 4_000); // 4s so Monaco has time to initialize

  // ═══════════════════════════════════════════════════════════════════════════
  //  TOAST
  // ═══════════════════════════════════════════════════════════════════════════

  function showToast(html, type = "success") {
    document.getElementById("dsa-tracker-toast")?.remove();
    const el = document.createElement("div");
    el.id = "dsa-tracker-toast";
    el.innerHTML = html;
    const BG = {
      success: "linear-gradient(135deg,#16a34a,#15803d)",
      error: "linear-gradient(135deg,#dc2626,#b91c1c)",
      info: "linear-gradient(135deg,#2563eb,#1d4ed8)",
      warning: "linear-gradient(135deg,#d97706,#b45309)",
    };
    el.setAttribute("style", `
      position:fixed!important;bottom:28px!important;right:28px!important;
      background:${BG[type] ?? BG.success}!important;color:#fff!important;
      padding:12px 18px!important;border-radius:12px!important;font-size:13px!important;
      font-family:Inter,-apple-system,system-ui,sans-serif!important;font-weight:500!important;
      z-index:2147483647!important;box-shadow:0 8px 32px rgba(0,0,0,.45)!important;
      max-width:320px!important;line-height:1.6!important;display:block!important;
      pointer-events:none!important;opacity:1!important;
      transition:opacity .4s ease,transform .4s ease!important;
    `);
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.setProperty("opacity", "0", "important");
      setTimeout(() => el?.remove(), 450);
    }, 5500);
  }

  function timeSince(ts) {
    const s = Math.round((Date.now() - (ts ?? 0)) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  KEYBOARD SHORTCUTS (capture phase so we fire before Monaco)
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener("keydown", async e => {
    if (!e.ctrlKey || !e.shiftKey) return;

    if (!chrome?.runtime?.id) {
      showToast("🔄 Extension reloaded. Please refresh (F5).", "warning");
      return;
    }

    const key = e.key?.toUpperCase();

    // Ctrl+Shift+Z — Restore (Time Machine)
    if (key === "Z") {
      e.preventDefault();
      e.stopImmediatePropagation();

      // 1) Use in-memory snapshot first (current session)
      if (snapshots.length) {
        const snap = snapshots[0];
        showToast("⏳ Restoring code…", "info");
        const ok = await setCode(snap.code);
        if (ok) {
          showToast(
            `⏪ <b>Code restored!</b><br><small>${snap.code.split("\n").length} lines · saved ${timeSince(snap.savedAt)} ago</small>`,
            "info"
          );
        } else {
          showToast(
            "⚠️ <b>Editor not ready.</b><br><small>Click inside the code editor first, then try again.</small>",
            "warning"
          );
        }
        return;
      }

      // 2) Fallback: load from chrome.storage
      showToast("⏳ Loading saved snapshot…", "info");
      try {
        const res = await safeMessage({ type: "GET_SNAPSHOTS" });
        if (!res) return;
        if (res.snapshots?.length) {
          const snap = { ...res.snapshots[0], code: sanitizeCode(res.snapshots[0].code) };
          const ok = await setCode(snap.code);
          if (ok) {
            snapshots.unshift(snap);
            showToast(
              `⏪ <b>Code restored!</b><br><small>${snap.code.split("\n").length} lines · saved ${timeSince(snap.savedAt)} ago</small>`,
              "info"
            );
          } else {
            showToast("⚠️ <b>Editor not ready.</b><br><small>Click inside the code editor first.</small>", "warning");
          }
        } else {
          showToast("⚠️ No snapshots yet.<br><small>Snapshots save every 30s while you code.</small>", "warning");
        }
      } catch (err) {
        showToast("❌ Restore failed: " + (err?.message ?? "unknown error"), "error");
      }
      return;
    }

    // Ctrl+Shift+G — Manual push
    if (key === "G") {
      e.preventDefault();
      e.stopImmediatePropagation();
      showToast("⏳ Reading editor…", "info");
      const code = await getCode();
      if (!code?.trim()) {
        showToast(
          "⚠️ <b>No code found.</b><br><small>Make sure the editor is fully loaded and you are on a problem page.</small>",
          "warning"
        );
        return;
      }
      showToast("🔄 Pushing to GitHub…", "info");
      await doPush(code);
    }
  }, true);

  // ═══════════════════════════════════════════════════════════════════════════
  //  SUBMIT DETECTION (event delegation — works even after React remounts)
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener("click", async e => {
    const btn = e.target?.closest?.("button");
    if (!btn || !platform.isSubmitBtn?.(btn)) return;

    // Don't try to communicate if extension context is dead
    if (!chrome?.runtime?.id) return;

    console.log("[DSA Tracker] 🚀 Submit clicked:", btn.textContent?.trim());

    // Capture everything NOW — before React/SPA navigates away or DOM changes
    const code = await getCode();
    if (code) {
      _pendingSubmission = {
        code,
        questionName: getQuestionName(),
        questionUrl: location.href,
        platform: platform.id,
        difficulty: platform.getDifficulty?.() ?? null,
        language: getLanguage(),
      };
      const snap = { code, savedAt: Date.now(), url: location.href };
      snapshots.unshift(snap);
      if (snapshots.length > MAX_SNAPS) snapshots.length = MAX_SNAPS;
      safeMessage({ type: "SAVE_SNAPSHOT", payload: { code, url: location.href } }).catch(() => { });
      console.log("[DSA Tracker] 📌 Captured submission metadata at submit:", _pendingSubmission.questionName);
    } else {
      console.warn("[DSA Tracker] ⚠️ Could not capture code at submit — bridge may not be ready.");
    }

    startSuccessWatcher();
  }, true);

  function startSuccessWatcher(maxWait = 30_000) {
    if (_successTimer) { clearInterval(_successTimer); _successTimer = null; }
    const deadline = Date.now() + maxWait;

    // 2s delay before polling: lets Code360 load the result UI
    setTimeout(() => {
      _successTimer = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(_successTimer); _successTimer = null;
          console.log("[DSA Tracker] Success watcher timed out.");
          return;
        }
        if (!platform.isSuccess()) return;
        clearInterval(_successTimer); _successTimer = null;
        console.log("[DSA Tracker] ✅ Accepted! Triggering auto-push...");
        onSubmitSuccess();
      }, 1000);
    }, 2000);
  }

  async function onSubmitSuccess() {
    await sleep(500);
    const submission = _pendingSubmission;
    _pendingSubmission = null;

    if (!submission?.code?.trim()) {
      showToast(
        "⚠️ Code capture failed.<br><small>Press <b>Ctrl+Shift+G</b> to push manually.</small>",
        "warning"
      );
      return;
    }
    showToast("🔄 Pushing to GitHub…", "info");
    await doPush(submission);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GITHUB PUSH
  // ═══════════════════════════════════════════════════════════════════════════

  async function doPush(payloadOverride = null) {
    try {
      let payload = payloadOverride;
      if (!payload) {
        // Manual push (Ctrl+Shift+G)
        const code = await getCode();
        if (!code) throw new Error("Could not extract code");
        payload = {
          code,
          questionName: getQuestionName(),
          questionUrl: location.href,
          platform: platform.id,
          difficulty: platform.getDifficulty?.() ?? null,
          language: getLanguage(),
        };
      }

      const resp = await safeMessage({
        type: "PUSH_SOLUTION",
        payload
      });

      if (!resp) return; // safeMessage already showed "reload" toast

      if (!resp.success) throw new Error(resp.error ?? "Unknown error from service worker");

      const file = resp.filePath?.split("/").pop() ?? "";
      showToast(
        `✅ <b>Day-${resp.dayNumber} pushed!</b><br>` +
        `<small>🔥 ${resp.streak?.currentStreak ?? "?"}-day streak · ${file}</small>` +
        (resp.milestone ? `<br><small>🏆 ${resp.milestone}-day milestone!</small>` : ""),
        "success"
      );
    } catch (err) {
      const msg = err?.message ?? "";
      if (msg.includes("ALREADY_PUSHED_TODAY")) return showToast("⚠️ You have already pushed this question today.<br><small>Try pushing another question or come back tomorrow.</small>", "warning");
      if (msg.includes("NOT_AUTHENTICATED")) return showToast("🔐 Login with GitHub — click the extension icon.", "warning");
      if (msg.includes("Repo not configured")) return showToast("⚙️ Set repo name — click the extension icon.", "warning");
      showToast(`❌ Push failed: ${msg}<br><small>Try Ctrl+Shift+G to retry.</small>`, "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FLOATING BADGE
  // ═══════════════════════════════════════════════════════════════════════════

  async function renderBadge() {
    try {
      if (!chrome?.runtime?.id) return;
      const data = await safeMessage({ type: "GET_POPUP_DATA" });
      if (!data?.profile) return;
      document.getElementById("dsa-badge")?.remove();
      const b = document.createElement("div");
      b.id = "dsa-badge";
      b.title = "DSA Tracker\nCtrl+Shift+G = Push  |  Ctrl+Shift+Z = Restore";
      b.innerHTML = `🔥 <b>Day ${data.dayNumber}</b> · ${data.streakData?.currentStreak ?? 0}d`;
      b.setAttribute("style", `
        position:fixed!important;top:70px!important;right:14px!important;
        background:linear-gradient(135deg,#16a34a,#15803d)!important;
        color:#fff!important;padding:5px 13px!important;border-radius:20px!important;
        font-size:12px!important;font-family:Inter,system-ui,sans-serif!important;
        font-weight:600!important;z-index:2147483646!important;
        cursor:default!important;user-select:none!important;display:block!important;
        box-shadow:0 2px 14px rgba(22,163,74,.5)!important;
        transition:transform .2s ease!important;
      `);
      b.onmouseenter = () => b.style.setProperty("transform", "scale(1.06)", "important");
      b.onmouseleave = () => b.style.setProperty("transform", "scale(1)", "important");
      document.body.appendChild(b);
    } catch (_) { }
  }

  setTimeout(renderBadge, 4000);

})();
