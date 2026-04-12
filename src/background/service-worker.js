// ─── Service Worker (Background) ─────────────────────────────────────────────
// Handles: OAuth flow, GitHub API calls, alarms, message routing

import {
  GITHUB_CLIENT_ID, GITHUB_AUTH_URL, GITHUB_REDIRECT_URI,
  GITHUB_SCOPES, REMINDER_ALARM, REMINDER_HOUR, MAX_SNAPSHOTS,
} from "../shared/constants.js";

import {
  setAccessToken, getAccessToken, clearAccessToken,
  setUserProfile, getUserProfile, clearUserProfile,
  getRepoName, setSignupDate, getSignupDate,
  recordPush, appendPushHistory, getPushHistory,
  getCurrentDayNumber, getStreakData, saveStreakData,
  getSnapshots, saveSnapshots,
} from "../shared/storage.js";

import {
  fetchAuthenticatedUser, ensureRepo, pushFilesToRepo,
  buildReadme,
} from "../shared/github-api.js";

import {
  buildFilePath, buildCodeFile, todayISO,
} from "../shared/utils.js";

// ─── Install handler ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log("[DSA Tracker] onInstalled:", reason);
  await scheduleReminder();

  // Clean up any old snapshots that may have \u00a0 corruption from
  // the legacy .view-lines DOM fallback. Run on every install/update.
  try {
    const snaps = await getSnapshots();
    const cleaned = snaps
      .filter(s => s?.code)
      .map(s => ({
        ...s,
        code: s.code
          .replace(/\u00a0/g, " ")
          .replace(/\u200b/g, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n"),
      }));
    await saveSnapshots(cleaned);
    console.log("[DSA Tracker] Snapshot sanitization done:", cleaned.length, "snaps");
  } catch (e) {
    console.warn("[DSA Tracker] Snapshot sanitization failed:", e);
  }
});

// ─── Alarm handler — daily reminder ──────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REMINDER_ALARM) return;

  const token = await getAccessToken();
  if (!token) return;

  const streak  = await getStreakData();
  const today   = todayISO();

  if (streak.lastPushDate !== today) {
    const dayNumber = await getCurrentDayNumber();
    chrome.notifications.create("daily-reminder", {
      type:    "basic",
      iconUrl: "/assets/icons/icon-128.png",
      title:   `🔥 DSA Tracker — Day ${dayNumber}`,
      message: "Aaj ka question abhi tak push nahi hua! Streak mat torna 💪",
      buttons: [{ title: "Open LeetCode" }],
    });
  }
  await scheduleReminder();
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (notifId === "daily-reminder" && btnIdx === 0) {
    chrome.tabs.create({ url: "https://leetcode.com" });
  }
});

async function scheduleReminder() {
  await chrome.alarms.clear(REMINDER_ALARM);
  const now  = new Date();
  const fire = new Date();
  fire.setHours(REMINDER_HOUR, 0, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);
  chrome.alarms.create(REMINDER_ALARM, { when: fire.getTime() });
}

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => {
      console.error("[DSA Tracker] Message error:", err);
      sendResponse({ success: false, error: err.message });
    });
  return true; // keep channel open for async
});

async function handleMessage(msg) {
  switch (msg.type) {

    case "INITIATE_OAUTH":
      return initiateGitHubOAuth();

    case "LOGOUT":
      return handleLogout();

    case "GET_AUTH_STATUS":
      return getAuthStatus();

    case "PUSH_SOLUTION":
      return pushSolution(msg.payload);

    case "SAVE_SNAPSHOT":
      return saveSnapshotHandler(msg.payload);

    case "GET_SNAPSHOTS":
      return getSnapshotsHandler();

    case "GET_POPUP_DATA":
      return getPopupData();

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────

async function initiateGitHubOAuth() {
  const state   = crypto.randomUUID();
  const authURL = new URL(GITHUB_AUTH_URL);
  authURL.searchParams.set("client_id",    GITHUB_CLIENT_ID);
  authURL.searchParams.set("redirect_uri", GITHUB_REDIRECT_URI);
  authURL.searchParams.set("scope",        GITHUB_SCOPES);
  authURL.searchParams.set("state",        state);

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url:         authURL.toString(),
      interactive: true,
    });
  } catch (e) {
    throw new Error("OAuth cancelled or failed: " + e.message);
  }

  if (!redirectUrl) throw new Error("OAuth flow returned no redirect URL");

  const params = new URL(redirectUrl).searchParams;
  if (params.get("state") !== state) throw new Error("OAuth state mismatch — possible CSRF");

  const code = params.get("code");
  if (!code) throw new Error("No auth code received from GitHub");

  // Exchange code → token via Cloudflare Worker proxy
  const tokenRes = await fetch("https://fancy-hall-6618.vdeendayal866.workers.dev", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ code }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("Token exchange failed: " + (tokenData.error ?? "unknown"));

  await setAccessToken(tokenData.access_token);

  // Fetch and persist user profile
  const profile = await fetchAuthenticatedUser();
  await setUserProfile(profile);

  // Set signup date only on first ever login
  const existingDate = await getSignupDate();
  if (!existingDate) await setSignupDate(new Date().toISOString());

  return { success: true, profile };
}

async function handleLogout() {
  await clearAccessToken();
  await clearUserProfile();
  return { success: true };
}

async function getAuthStatus() {
  try {
    const token   = await getAccessToken();
    const profile = await getUserProfile();
    if (!token) return { authenticated: false, profile: null };

    // If we have a token but no cached profile, re-fetch it (first install edge case)
    if (token && !profile) {
      try {
        const freshProfile = await fetchAuthenticatedUser();
        await setUserProfile(freshProfile);
        return { authenticated: true, profile: freshProfile };
      } catch {
        // Token might be expired — clear it
        await clearAccessToken();
        return { authenticated: false, profile: null };
      }
    }

    return { authenticated: !!token, profile };
  } catch (e) {
    console.error("[DSA Tracker] getAuthStatus error:", e);
    return { authenticated: false, profile: null };
  }
}

// ─── Solution push pipeline ───────────────────────────────────────────────────

async function pushSolution(payload) {
  const {
    code, questionName, questionUrl,
    platform, difficulty, language,
  } = payload;

  const profile = await getUserProfile();
  if (!profile) throw new Error("User not authenticated");

  const repoName = await getRepoName();
  if (!repoName) throw new Error("Repo not configured");

  const dayNumber = await getCurrentDayNumber();
  const today     = todayISO();

  await ensureRepo(profile.login, repoName);

  const filePath   = buildFilePath({ dayNumber, questionName, platformName: platform, difficulty, language });
  const fileContent = buildCodeFile({
    code, questionName, questionUrl,
    platform, difficulty, language,
    dayNumber, date: today,
  });

  const pushHistory  = await getPushHistory();
  const streakBefore = await getStreakData();

  const newEntry = {
    dayNumber, questionName, questionUrl,
    platform, difficulty, language,
    date: today, filePath, commitSHA: null,
  };

  const updatedReadme = buildReadme(profile, [newEntry, ...pushHistory], streakBefore);

  const commitMessage =
    `✅ Day-${dayNumber}: ${questionName} [${platform}]${difficulty ? ` — ${difficulty}` : ""}`;

  const { commitSHA } = await pushFilesToRepo({
    owner:         profile.login,
    repo:          repoName,
    commitMessage,
    files: [
      { path: filePath,     content: fileContent },
      { path: "README.md",  content: updatedReadme },
    ],
  });

  newEntry.commitSHA = commitSHA;

  const streakAfter = await recordPush(today);
  await appendPushHistory(newEntry);

  const milestone = checkMilestone(streakAfter.currentStreak);

  return {
    success: true,
    filePath,
    commitSHA,
    dayNumber,
    streak:    streakAfter,
    milestone,
  };
}

function checkMilestone(streak) {
  const milestones = [7, 14, 30, 60, 100, 200, 365];
  return milestones.includes(streak) ? streak : null;
}

// ─── Code Time Machine snapshots ─────────────────────────────────────────────

async function saveSnapshotHandler(payload) {
  const { code: rawCode, url } = payload;
  // Sanitize before save — guards against \u00a0 from any source
  const code = (rawCode ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!code.trim()) return { success: false, error: "Empty code" };
  const snaps = await getSnapshots();
  snaps.unshift({ code, url, savedAt: Date.now() });
  if (snaps.length > MAX_SNAPSHOTS) snaps.length = MAX_SNAPSHOTS;
  await saveSnapshots(snaps);
  return { success: true };
}

async function getSnapshotsHandler() {
  const snaps = await getSnapshots();
  return { success: true, snapshots: snaps };
}

// ─── Popup data aggregator ────────────────────────────────────────────────────

async function getPopupData() {
  const profile     = await getUserProfile();
  const repoName    = await getRepoName();
  const streakData  = await getStreakData();
  const dayNumber   = await getCurrentDayNumber();
  const signupDate  = await getSignupDate();
  const pushHistory = (await getPushHistory()).slice(0, 10);

  return {
    profile,
    repoName,
    streakData,
    dayNumber,
    signupDate,
    recentPushes: pushHistory,
  };
}
