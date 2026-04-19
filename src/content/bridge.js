// ─── DsGit — Monaco Bridge ─────────────────────────────────────────────────────
// This file runs in the PAGE's MAIN JavaScript world (declared in manifest.json
// with "world": "MAIN"). This bypasses naukri.com's strict CSP that blocks all
// inline script injection (s.textContent = ...).
//
// Running in MAIN world gives us direct access to window.monaco — the real
// Monaco editor API — which is NOT accessible from isolated content scripts.
//
// Communication: content-main.js (isolated) ↔ postMessage ↔ bridge.js (main)

(function () {
  // Guard: only run once per page
  if (window.__DSA_B__) return;
  window.__DSA_B__ = true;

  console.log("[DSA Bridge] ✅ Loaded in MAIN world — window.monaco accessible");

  window.addEventListener("message", function (e) {
    // Only handle messages from our content script
    if (!e.data || e.data._t !== "dsa_cs") return;

    const id = e.data.id;
    let r = null, er = null;

    try {
      // ── GET code from Monaco ──────────────────────────────────────────────
      if (e.data.a === "get") {
        try {
          // 1. Try active editor
          let eds = window.monaco?.editor?.getEditors?.() || [];
          if (eds.length > 0) {
            const v = eds[0].getValue?.();
            if (typeof v === "string" && v.trim()) r = v;
          }
          
          // 2. Try all models
          if (!r) {
            const mods = window.monaco?.editor?.getModels?.() || [];
            let bestModel = null, maxLen = -1;
            for (let i = 0; i < mods.length; i++) {
              try {
                const val = mods[i]?.getValue?.() || "";
                if (typeof val === "string" && val.length > maxLen) {
                  maxLen = val.length;
                  bestModel = mods[i];
                }
              } catch (_) {}
            }
            if (bestModel) r = bestModel.getValue?.();
          }

          // 3. Try Angular component (Code360)
          if (!r && window.ng?.getComponent) {
            const el = document.querySelector('ngx-monaco-editor, [class*="monaco-editor"]');
            if (el) {
              const comp = window.ng.getComponent(el);
              if (comp && comp.value) r = comp.value;
            }
          }

          // 4. If still no code and Monaco not ready, retry later
          if (!r && !window.monaco && !window.ng) {
            er = "Editor not initialized yet";
          }
        } catch (err) {
          er = "get_code error: " + err.message;
        }

        if (r) {
          console.log("[DSA Bridge] getCode success:", r.length, "chars");
        } else {
          console.warn("[DSA Bridge] getCode failed. monaco =", typeof window.monaco, "ng =", typeof window.ng, "editors =", window.monaco?.editor?.getEditors?.()?.length || 0);
          er = er || "Monaco API returned empty or is not accessible.";
        }
      }

      // ── SET code in Monaco ────────────────────────────────────────────────
      if (e.data.a === "set" && typeof e.data.c === "string") {
        const code = e.data.c;
        try {
          const eds = window.monaco?.editor?.getEditors?.() || [];
          if (eds.length > 0) {
            eds[0].setValue?.(code);
            eds[0].setScrollTop?.(0);
            eds[0].focus?.();
            r = true;
          } else {
            const mods = window.monaco?.editor?.getModels?.() || [];
            let bestModel = null, maxLen = -1;
            for (let i = 0; i < mods.length; i++) {
              try {
                const val = mods[i]?.getValue?.() || "";
                if (typeof val === "string" && val.length > maxLen) {
                  maxLen = val.length; bestModel = mods[i];
                }
              } catch (_) {}
            }
            if (bestModel) {
              bestModel.setValue?.(code);
              r = true;
            }
          }

          if (!r && window.ng?.getComponent) {
            const el = document.querySelector('ngx-monaco-editor, [class*="monaco-editor"]');
            if (el) {
              const comp = window.ng.getComponent(el);
              if (comp) {
                if (typeof comp.writeValue === "function") comp.writeValue(code);
                else comp.value = code;
                r = true;
              }
            }
          }
          
          if (!r) {
            er = "No Monaco editors/models found to set.";
            console.warn("[DSA Bridge]", er);
          }
        } catch (err) {
          er = "set_code error: " + err.message;
        }
      }
    } catch (x) {
      er = x.message;
      console.error("[DSA Bridge] Error:", x);
    }

    // Reply to content script
    window.postMessage({ _t: "dsa_pg", id: id, r: r, er: er }, "*");
  });
})();
