import { getRepoName, setRepoName, getStreakData, getSignupDate, getPushHistory, saveSettings, getSettings, getCurrentDayNumber } from "../shared/storage.js";

function send(type, payload) { return chrome.runtime.sendMessage({ type, payload }); }

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

(async function load() {
  const [authResult, repoName, streakRaw, signupDate, historyRaw, dayNumber, settings] = await Promise.all([
    send("GET_AUTH_STATUS"),
    getRepoName(),
    getStreakData(),
    getSignupDate(),
    getPushHistory(),
    getCurrentDayNumber(),
    getSettings(),
  ]);

  // Safe defaults — agar storage empty hai to crash na ho
  const profile     = authResult?.profile ?? null;
  const pushHistory = Array.isArray(historyRaw) ? historyRaw : [];
  const streakData  = streakRaw ?? { currentStreak: 0, longestStreak: 0, breaks: [], history: [] };

  // Header
  document.getElementById("user-sub").textContent = profile ? `@${profile.login}` : "Not logged in";
  document.getElementById("field-user").value     = profile?.login ?? "";
  document.getElementById("field-repo").value     = repoName ?? "";

  // Stats
  document.getElementById("s-current").textContent = streakData.currentStreak ?? 0;
  document.getElementById("s-longest").textContent  = streakData.longestStreak ?? 0;
  document.getElementById("s-total").textContent    = pushHistory.length;
  document.getElementById("s-started").textContent  = signupDate
    ? new Date(signupDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";
  document.getElementById("s-day").textContent    = `Day ${dayNumber ?? 1}`;
  document.getElementById("s-breaks").textContent = (streakData.breaks ?? []).length;

  // Toggles & Email
  const s = settings ?? { reminder: true, autoPush: true, showBadge: true, sound: false, email: "" };
  document.getElementById("field-email").value = s.email ?? "";
  
  document.querySelectorAll(".toggle").forEach(btn => {
    const key = btn.dataset.key;
    if (s[key] === false) btn.classList.remove("on");
    btn.addEventListener("click", () => btn.classList.toggle("on"));
  });

  // Push history
  const histEl = document.getElementById("push-history-list");
  if (!pushHistory.length) {
    histEl.innerHTML = `<div style="font-size:13px;color:var(--gray-400);text-align:center;padding:8px 0;">No pushes yet!</div>`;
  } else {
    histEl.innerHTML = pushHistory.slice(0, 50).map(p => `
      <div class="history-item">
        <span class="h-day">Day ${p.dayNumber}</span>
        <span class="h-name" title="${p.questionName}">${p.questionName}</span>
        <span class="h-plat">${p.platform}</span>
        <span class="h-date">${p.date}</span>
      </div>
    `).join("");
  }

  // Button handlers
  document.getElementById("btn-open-repo").onclick = () => {
    if (profile && repoName) window.open(`https://github.com/${profile.login}/${repoName}`, "_blank");
  };

  document.getElementById("btn-save-repo").onclick = async () => {
    const val = document.getElementById("field-repo").value.trim();
    if (!val) { alert("Enter a repo name."); return; }
    await setRepoName(val);
    showToast("✅ Repo saved!");
  };

  document.getElementById("btn-save-settings").onclick = async () => {
    const newSettings = {};
    document.querySelectorAll(".toggle").forEach(btn => {
      newSettings[btn.dataset.key] = btn.classList.contains("on");
    });
    
    newSettings.email = document.getElementById("field-email").value.trim();
    await saveSettings(newSettings);
    
    // Attempt to sync email with backend if user is logged in
    const profile = document.getElementById("field-user").value;
    if (profile && newSettings.email) {
      try {
        await fetch('https://api-dsgit.onrender.com/api/update-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: profile, email: newSettings.email })
        });
      } catch(e) {
        console.error("Failed to sync email to backend:", e);
      }
    }
    
    showToast("✅ Settings saved!");
  };

  document.getElementById("btn-reset-streak").onclick = async () => {
    if (!confirm("This will reset your streak data. Are you sure?")) return;
    await chrome.storage.local.remove("streak_data");
    showToast("Streak data cleared.");
    setTimeout(() => location.reload(), 1000);
  };

  document.getElementById("btn-logout").onclick = async () => {
    if (!confirm("Logout from DSA Tracker?")) return;
    await send("LOGOUT");
    window.close();
  };
})();