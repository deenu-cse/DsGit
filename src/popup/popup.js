// ─── Popup Script ─────────────────────────────────────────────────────────────
// Premium UI with fixed auth persistence + improved error handling

import { STREAK_MILESTONES } from "../shared/constants.js";
import { getRepoName, setRepoName } from "../shared/storage.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  const screen = $(`screen-${name}`);
  screen.classList.remove("hidden");
  // Trigger re-animation of child elements
  screen.querySelectorAll("[style*='animation']").forEach(el => {
    el.style.animation = "none";
    el.offsetHeight; // reflow
    el.style.animation = "";
  });
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
// FIX: Robust auth check — never silently falls back to login due to unrelated errors

(async function boot() {
  showScreen("loading");

  let authResult;
  try {
    authResult = await send("GET_AUTH_STATUS");
  } catch (e) {
    console.error("[DSA Tracker Popup] GET_AUTH_STATUS failed:", e);
    // Service worker may have just started — retry once after a short delay
    await sleep(800);
    try {
      authResult = await send("GET_AUTH_STATUS");
    } catch {
      showScreen("login");
      return;
    }
  }

  const { authenticated, profile } = authResult ?? {};

  if (!authenticated) {
    showScreen("login");
    return;
  }

  // Authenticated — check if repo has been set up
  const repoName = await getRepoName();
  if (!repoName) {
    renderSetupScreen(profile);
    showScreen("setup");
    return;
  }

  // Load full dashboard data
  try {
    const data = await send("GET_POPUP_DATA");
    if (data?.profile) {
      renderDashboard(data);
      showScreen("main");
    } else {
      // Profile missing in response — show setup
      renderSetupScreen(profile);
      showScreen("setup");
    }
  } catch (e) {
    console.error("[DSA Tracker Popup] GET_POPUP_DATA failed:", e);
    // Don't kick to login — user is authenticated, something else went wrong
    showScreen("login");
  }
})();

// ─── Login Screen ──────────────────────────────────────────────────────────────

$("btn-login").addEventListener("click", async () => {
  const btn = $("btn-login");
  const span = btn.querySelector("span");
  btn.classList.add("loading");
  span.textContent = "Connecting to GitHub…";
  btn.disabled = true;

  try {
    const result = await send("INITIATE_OAUTH");
    if (!result?.success) throw new Error(result?.error ?? "OAuth failed");

    const profile = result.profile;
    const repoName = await getRepoName();

    if (!repoName) {
      renderSetupScreen(profile);
      showScreen("setup");
    } else {
      const data = await send("GET_POPUP_DATA");
      renderDashboard(data);
      showScreen("main");
    }
  } catch (e) {
    console.error("[DSA Tracker Popup] Login error:", e);
    showErrorToast("Login failed: " + (e.message ?? "Please try again."));
    span.textContent = "Continue with GitHub";
    btn.classList.remove("loading");
    btn.disabled = false;
  }
});

// ─── Setup Screen ──────────────────────────────────────────────────────────────

function renderSetupScreen(profile) {
  if (!profile) return;
  $("setup-avatar").src = profile.avatar_url ?? "";
  $("setup-username").textContent = profile.login ?? "";
}

$("btn-save-setup").addEventListener("click", async () => {
  const repoInput = $("input-repo").value.trim();
  if (!repoInput) {
    showErrorToast("Please enter a repo name.");
    $("input-repo").focus();
    return;
  }

  const btn = $("btn-save-setup");
  $("setup-btn-text").textContent = "Setting up repo… ✨";
  btn.disabled = true;

  try {
    await setRepoName(repoInput);
    const data = await send("GET_POPUP_DATA");
    renderDashboard(data);
    showScreen("main");
  } catch (e) {
    showErrorToast("Setup failed: " + e.message);
    $("setup-btn-text").textContent = "Start Tracking 🚀";
    btn.disabled = false;
  }
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function renderDashboard(data) {
  const profile      = data?.profile;
  const repoName     = data?.repoName ?? "";
  const streakData   = data?.streakData ?? { currentStreak: 0, longestStreak: 0, breaks: [], history: [] };
  const dayNumber    = data?.dayNumber ?? 1;
  const recentPushes = Array.isArray(data?.recentPushes) ? data.recentPushes : [];

  if (!profile) { showScreen("login"); return; }

  // Header
  $("dash-avatar").src         = profile.avatar_url ?? "";
  $("dash-username").textContent = profile.login ?? "";

  // Day + Streak
  $("day-number").textContent  = dayNumber;
  animateCount("streak-count", streakData.currentStreak);
  $("streak-best").textContent = `🏆 Best: ${streakData.longestStreak} days`;

  // Today solved badge
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayH   = streakData.history?.find(h => h.date === todayISO);
  if (todayH) $("today-badge").classList.remove("hidden");

  // Break banner
  if (streakData.breaks?.length > 0 && streakData.currentStreak <= 1 && streakData.lastPushDate !== todayISO) {
    const lastBreak = streakData.breaks[streakData.breaks.length - 1];
    $("break-banner").classList.remove("hidden");
    $("break-message").textContent = `You missed ${formatDate(lastBreak)}. New streak started — keep going! 💪`;
  }

  // Milestone banner
  const milestone = STREAK_MILESTONES.find(m => streakData.currentStreak === m.days);
  if (milestone) {
    $("milestone-banner").classList.remove("hidden");
    $("milestone-text").textContent = `${milestone.badge} — ${streakData.currentStreak} days!`;
  }

  // Stats
  const totalSolved = streakData.history?.reduce((a, h) => a + h.count, 0) ?? 0;
  animateCount("stat-total",  totalSolved);
  animateCount("stat-breaks", streakData.breaks?.length ?? 0);
  animateCount("stat-today",  todayH?.count ?? 0);

  // Heatmap
  renderHeatmap(streakData, 30);

  // Recent pushes
  renderRecentList(recentPushes, profile.login, repoName);

  // Repo link
  const repoUrl = `https://github.com/${profile.login}/${repoName}`;
  const repoLink = $("repo-link");
  repoLink.href        = repoUrl;
  repoLink.textContent = `${profile.login}/${repoName} →`;

  // Settings
  $("btn-settings").onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options/options.html") });
    window.close();
  };

  // Share
  $("btn-share").onclick = () => generateShareCard(profile, streakData, dayNumber);

  // Logout
  $("btn-logout").onclick = async () => {
    if (!confirm("Log out of DSA Tracker?")) return;
    await send("LOGOUT");
    // Reset banners
    $("break-banner").classList.add("hidden");
    $("milestone-banner").classList.add("hidden");
    $("today-badge").classList.add("hidden");
    showScreen("login");
  };

  // Battles handling
  renderBattlesUI(data.battles || [], data.badges || []);

  // Set up Tabs
  $("tab-dash").onclick = () => switchTab("dash");
  $("tab-battles").onclick = () => switchTab("battles");
}

function switchTab(tab) {
  $("view-dash").style.display = "none";
  $("view-battles").style.display = "none";
  $("tab-dash").style.opacity = "0.5";
  $("tab-dash").style.borderBottom = "none";
  $("tab-battles").style.opacity = "0.5";
  $("tab-battles").style.borderBottom = "none";
  
  if (tab === "dash") {
    $("view-dash").style.display = "block";
    $("tab-dash").style.opacity = "1";
    $("tab-dash").style.borderBottom = "2px solid #22c55e";
  } else {
    $("view-battles").style.display = "block";
    $("tab-battles").style.opacity = "1";
    $("tab-battles").style.borderBottom = "2px solid #a855f7";
  }
}

// ─── Animated Counter ─────────────────────────────────────────────────────────

function animateCount(id, target) {
  const el    = $(id);
  const start = 0;
  const dur   = 600;
  const step  = 16;
  const steps = dur / step;
  let current = start;
  const inc   = (target - start) / steps;

  const timer = setInterval(() => {
    current += inc;
    if (current >= target) {
      el.textContent = target;
      clearInterval(timer);
    } else {
      el.textContent = Math.floor(current);
    }
  }, step);
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

function renderHeatmap(streakData, days = 30) {
  const container = $("heatmap");
  container.innerHTML = "";

  const todayISO  = new Date().toISOString().slice(0, 10);
  const histMap   = Object.fromEntries((streakData.history ?? []).map(h => [h.date, h.count]));
  const breaksSet = new Set(streakData.breaks ?? []);

  for (let i = days - 1; i >= 0; i--) {
    const d   = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const count = histMap[iso] ?? 0;

    const cell    = document.createElement("div");
    cell.className = "hm-cell";
    cell.title    = `${formatDate(iso)}${count ? ` — ${count} solved` : " — no activity"}`;

    if (iso === todayISO && count > 0) {
      cell.classList.add("today");
    } else if (count > 1) {
      cell.classList.add("solved-multi");
    } else if (count === 1) {
      cell.classList.add("solved");
    } else if (breaksSet.has(iso)) {
      cell.classList.add("missed");
    }

    container.appendChild(cell);
  }
}

// ─── Recent Pushes List ───────────────────────────────────────────────────────

function renderRecentList(pushes, login, repoName) {
  const list = $("recent-list");
  list.innerHTML = "";

  if (!pushes.length) {
    list.innerHTML = `<div class="recent-empty">No pushes yet — go solve a problem! 💪</div>`;
    return;
  }

  pushes.slice(0, 5).forEach(p => {
    const el = document.createElement("div");
    el.className = "recent-item";

    const diffClass = p.difficulty
      ? `diff-${p.difficulty.toLowerCase()}`
      : "";

    const commitUrl = p.commitSHA
      ? `https://github.com/${login}/${repoName}/commit/${p.commitSHA}`
      : "#";

    el.innerHTML = `
      <span class="recent-day">Day ${p.dayNumber}</span>
      <span class="recent-name" title="${escHtml(p.questionName)}">${escHtml(p.questionName)}</span>
      <div class="recent-meta">
        <span class="recent-platform">${escHtml(p.platform ?? "")}</span>
        ${p.difficulty ? `<span class="recent-diff ${diffClass}">${p.difficulty}</span>` : ""}
      </div>
    `;

    if (p.commitSHA) {
      el.style.cursor = "pointer";
      el.onclick = () => chrome.tabs.create({ url: commitUrl });
    }

    list.appendChild(el);
  });
}

// ─── Share Streak Card ────────────────────────────────────────────────────────

function generateShareCard(profile, streakData, dayNumber) {
  const canvas  = document.createElement("canvas");
  canvas.width  = 640;
  canvas.height = 320;
  const ctx     = canvas.getContext("2d");

  // Dark background
  const bg = ctx.createLinearGradient(0, 0, 640, 320);
  bg.addColorStop(0, "#0d1117");
  bg.addColorStop(1, "#0f2a1a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 640, 320);

  // Glow overlay
  const glow = ctx.createRadialGradient(120, 160, 0, 120, 160, 220);
  glow.addColorStop(0, "rgba(34,197,94,0.12)");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 640, 320);

  // Subtle grid dots
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let x = 20; x < 640; x += 24)
    for (let y = 20; y < 320; y += 24)
      ctx.fillRect(x, y, 2, 2);

  // Fire + streak number
  ctx.font = "64px serif";
  ctx.fillText("🔥", 44, 140);

  ctx.font      = "bold 80px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = "#22c55e";
  ctx.fillText(streakData.currentStreak, 124, 150);

  ctx.font      = "24px system-ui, sans-serif";
  ctx.fillStyle = "rgba(240,246,252,0.75)";
  ctx.fillText("day streak", 128, 185);

  // Stats line
  const badge = getBadge(streakData.longestStreak);
  ctx.font      = "16px system-ui, sans-serif";
  ctx.fillStyle = "rgba(240,246,252,0.5)";
  ctx.fillText(
    `Day ${dayNumber}  ·  Best: ${streakData.longestStreak}d  ·  Breaks: ${streakData.breaks.length}`,
    44, 236
  );

  if (badge) {
    ctx.font      = "bold 17px system-ui, sans-serif";
    ctx.fillStyle = "#e3b341";
    ctx.fillText(badge, 44, 270);
  }

  // Username + branding
  ctx.font      = "14px system-ui, sans-serif";
  ctx.fillStyle = "rgba(240,246,252,0.35)";
  ctx.fillText(`github.com/${profile.login}  •  DSA Tracker Extension`, 44, 300);

  // Border
  ctx.strokeStyle = "rgba(34,197,94,0.3)";
  ctx.lineWidth   = 1.5;
  ctx.strokeRect(0.75, 0.75, 638.5, 318.5);

  const link  = document.createElement("a");
  link.download = `dsa-streak-day${streakData.currentStreak}.png`;
  link.href   = canvas.toDataURL("image/png");
  link.click();
}

function getBadge(streak) {
  const m = STREAK_MILESTONES.slice().reverse().find(m => streak >= m.days);
  return m?.badge ?? null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDate(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short",
  });
}

function escHtml(str) {
  return (str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function showErrorToast(msg) {
  const old = document.getElementById("popup-error-toast");
  if (old) old.remove();

  const el = document.createElement("div");
  el.id    = "popup-error-toast";
  el.textContent = msg;
  Object.assign(el.style, {
    position:      "fixed",
    bottom:        "16px",
    left:          "16px",
    right:         "16px",
    background:    "#f85149",
    color:         "#fff",
    padding:       "11px 14px",
    borderRadius:  "8px",
    fontSize:      "12px",
    fontWeight:    "500",
    zIndex:        "9999",
    textAlign:     "center",
    boxShadow:     "0 4px 16px rgba(0,0,0,0.5)",
    animation:     "fadeInUp 0.3s ease",
  });
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity   = "0";
    el.style.transition = "opacity 0.3s ease";
    setTimeout(() => el.remove(), 350);
  }, 4000);
}

// ─── Battles UI Logic ─────────────────────────────────────────────────────────

function renderBattlesUI(battles, badges) {
  const c = $("active-battles-container");
  c.innerHTML = "";
  
  if (!battles || battles.length === 0) {
    c.innerHTML = `<p style="color: #a1a1aa; font-size: 13px; text-align: center; margin: 0;">No active battles. Start one below!</p>`;
  } else {
    battles.forEach(b => {
      const el = document.createElement("div");
      el.style.background = "rgba(0,0,0,0.3)";
      el.style.border = "1px solid rgba(255,255,255,0.1)";
      el.style.borderRadius = "8px";
      el.style.padding = "10px";
      el.style.marginBottom = "8px";
      
      let statusHtml = "";
      if (b.status === "received_invite") {
         statusHtml = `<button data-id="${b.id}" class="btn-accept-battle" style="background:#a855f7; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; margin-top:8px;">Accept Challenge</button>`;
      } else if (b.status === "pending_invite") {
         statusHtml = `<span style="color:#fdba74; font-size:12px;">⏰ Waiting for opponent...</span>`;
      } else if (b.status === "active") {
         const daysLeft = Math.ceil((new Date(b.endDate) - new Date())/86400000);
         statusHtml = `<span style="color:#86efac; font-size:12px;">🔥 Active • ${daysLeft} days left</span>`;
      } else if (b.status === "won") {
         statusHtml = `<span style="color:#fbbf24; font-size:12px;">🏆 You Won!</span>`;
      } else if (b.status === "lost") {
         statusHtml = `<span style="color:#f87171; font-size:12px;">💔 You Lost!</span>`;
      } else {
         statusHtml = `<span style="color:#a1a1aa; font-size:12px;">Draw</span>`;
      }

      const cleanType = (b.type || "").split("-").join(" ").toUpperCase();
      el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="color:#fff; font-weight:600; font-size:13px;">vs @${b.opponent}</span>
          <span style="color:#a1a1aa; font-size:11px;">${cleanType}</span>
        </div>
        <div style="margin-top:8px;">${statusHtml}</div>
      `;
      c.appendChild(el);
    });
  }

  // Bind accept buttons
  document.querySelectorAll(".btn-accept-battle").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      const b = battles.find(x => x.id === id);
      btn.textContent = "Accepting...";
      btn.disabled = true;
      try {
        await send("ACCEPT_CHALLENGE", { 
           opponent: b.opponent, 
           battleId: b.id, 
           issueNumber: b.issueNumber, 
           type: b.type, 
           duration: b.duration,
           challengerRepo: b.challengerRepo
        });
        const updatedData = await send("GET_POPUP_DATA");
        renderBattlesUI(updatedData.battles, updatedData.badges);
      } catch (e) {
        showErrorToast(e.message || "Failed to accept challenge");
        btn.textContent = "Accept Challenge";
        btn.disabled = false;
      }
    };
  });

  const bC = $("badges-container");
  bC.innerHTML = "";
  if (!badges || badges.length === 0) {
    bC.innerHTML = `<p style="color: #52525b; font-size: 13px; margin: 0;">Play a battle to unlock badges!</p>`;
  } else {
    badges.forEach(bg => {
       const badgeEl = document.createElement("span");
       badgeEl.textContent = bg;
       badgeEl.style.cssText = "background: rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.4); color: #d8b4fe; padding: 4px 8px; border-radius: 12px; font-size: 12px;";
       bC.appendChild(badgeEl);
    });
  }
}

// ─── Challenge Sending Logic ──────────────────────────────────────────────────
$("btn-send-challenge").onclick = async () => {
  const opp = $("battle-target").value.trim();
  if (!opp) return showErrorToast("Enter opponent's GitHub username");
  const dTypeDom = $("battle-type");
  const type = dTypeDom.value; 
  const duration = type.includes("30") ? 30 : type.includes("7") ? 7 : type.includes("90") ? 90 : 14;

  const btn = $("btn-send-challenge");
  btn.textContent = "Sending...";
  btn.disabled = true;

  try {
    const res = await send("SEND_CHALLENGE", { opponent: opp, type, duration });
    if (!res?.success) throw new Error(res?.error || "Unknown Error");
    
    const updatedData = await send("GET_POPUP_DATA");
    renderBattlesUI(updatedData.battles, updatedData.badges);
    btn.textContent = "Sent! 🔥";
    $("battle-target").value = "";
  } catch (e) {
    showErrorToast(e.message);
    btn.textContent = "Send Challenge 🔥";
  } finally {
    setTimeout(() => { 
      btn.disabled = false; 
      if (btn.textContent === "Sent! 🔥") btn.textContent = "Send Challenge 🔥"; 
    }, 2000);
  }
};
