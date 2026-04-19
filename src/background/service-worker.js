// ─── Service Worker (Background) ─────────────────────────────────────────────
// Handles: OAuth flow, GitHub API calls, alarms, message routing

import {
  GITHUB_CLIENT_ID, GITHUB_AUTH_URL, GITHUB_REDIRECT_URI,
  GITHUB_SCOPES, REMINDER_ALARM, REMINDER_HOUR, MAX_SNAPSHOTS,
  BATTLES_POLL_ALARM, ISSUES_POLL_ALARM,
} from "../shared/constants.js";

import {
  setAccessToken, getAccessToken, clearAccessToken,
  setUserProfile, getUserProfile, clearUserProfile,
  getRepoName, setSignupDate, getSignupDate,
  recordPush, appendPushHistory, getPushHistory,
  getCurrentDayNumber, getStreakData, saveStreakData,
  getSnapshots, saveSnapshots,
  getBattles, saveBattles, getBadges, saveBadges,
  getStatsCache, saveStatsCache,
} from "../shared/storage.js";

import {
  fetchAuthenticatedUser, ensureRepo, pushFilesToRepo,
  buildReadme, fetchUserStatsJSON
} from "../shared/github-api.js";

import {
  buildFilePath, buildCodeFile, todayISO,
} from "../shared/utils.js";

// WebSocket connection state
let ws = null;
let wsIsConnected = false;
let wsReconnectDelay = 1000;
let wsMaxDelay = 8000;

function connectWebSocket() {
  getUserProfile().then(profile => {
    if (!profile) return;
    const WS_URL = `wss://api-dsgit.onrender.com?username=${profile.login}`;

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[DsGit] WebSocket Connected");
      wsIsConnected = true;
      wsReconnectDelay = 1000; // Reset backoff
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        await handleWebSocketMessage(data);
      } catch (e) {
        console.error("WS parse error", e);
      }
    };

    ws.onclose = () => {
      console.log("[DsGit] WebSocket Disconnected. Reconnecting in " + wsReconnectDelay + "ms...");
      wsIsConnected = false;
      setTimeout(connectWebSocket, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, wsMaxDelay);
    };

    ws.onerror = (err) => {
      console.error("[DsGit] WebSocket Error:", err);
      ws.close();
    };
  });
}

async function handleWebSocketMessage(data) {
  const { type, payload } = data;
  let battles = (await getBattles()) || [];
  let modified = false;

  if (type === 'CHALLENGE_RECEIVED') {
    const { battle } = payload;
    if (!battles.some(b => b.id === battle.battleId)) {
      battles.push({
        id: battle.battleId,
        type: battle.type,
        duration: battle.duration,
        opponent: battle.challenger,
        status: "received_invite",
        createdAt: new Date().toISOString()
      });
      modified = true;
      chrome.notifications.create({
        type: "basic", iconUrl: "/assets/icons/icon-128.png",
        title: "⚔️ New DSA Challenge!",
        message: `@${battle.challenger} has challenged you to a battle! Open extension to accept.`
      });
    }
  }
  else if (type === 'CHALLENGE_ACCEPTED') {
    const { battleId, opponent } = payload;
    const b = battles.find(x => x.id === battleId);
    if (b) {
      b.status = 'active';
      b.endDate = new Date(Date.now() + parseInt(b.duration || 30) * 86_400_000).toISOString().slice(0, 10);
      modified = true;
      chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "⚔️ Challenge Accepted!", message: `${opponent} accepted your challenge. Let the battle begin!` });
    }
  }
  else if (type === 'CHALLENGE_ACCEPTED_CONFIRM') {
    const { battleId } = payload;
    const b = battles.find(x => x.id === battleId);
    if (b) {
      b.status = 'active';
      b.endDate = new Date(Date.now() + parseInt(b.duration || 30) * 86_400_000).toISOString().slice(0, 10);
      modified = true;
    }
  }
  else if (type === 'BATTLE_WON') {
    const { battleId, loser } = payload;
    const b = battles.find(x => x.id === battleId);
    if (b) {
      b.status = 'won';
      modified = true;
      chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "🏆 Battle Won!", message: `${loser} broke their streak! You win the battle.` });
    }
  }
  else if (type === 'BATTLE_SYNC') {
    const { battle } = payload;
    // Use battleId for consistency - sync uses either id or battleId
    const battleId = battle.id || battle.battleId;
    const existingIndex = battles.findIndex(b => b.id === battleId);
    
    if (existingIndex !== -1) {
      // Update existing - merge data carefully to preserve participant details
      battles[existingIndex] = {
        ...battles[existingIndex],
        id: battleId,
        type: battle.type || battles[existingIndex].type,
        duration: battle.duration || battles[existingIndex].duration,
        opponent: battle.opponent || battles[existingIndex].opponent,
        status: battle.status || battles[existingIndex].status,
        endDate: battle.endDate || battles[existingIndex].endDate,
        participants: battle.participants || battles[existingIndex].participants,
        score: battle.score || battles[existingIndex].score,
        opponentScore: battle.opponentScore || battles[existingIndex].opponentScore,
        hardSolved: battle.hardSolved || battles[existingIndex].hardSolved,
        mediumSolved: battle.mediumSolved || battles[existingIndex].mediumSolved,
        easySolved: battle.easySolved || battles[existingIndex].easySolved,
        platforms: battle.platforms || battles[existingIndex].platforms
      };
      modified = true;
    } else {
      // Add new - with full data
      battles.push({
        id: battleId,
        type: battle.type || 'standard',
        duration: battle.duration || 7,
        opponent: battle.opponent || 'Opponent',
        status: battle.status || 'active',
        endDate: battle.endDate || null,
        participants: battle.participants || [],
        score: battle.score || 0,
        opponentScore: battle.opponentScore || 0,
        hardSolved: battle.hardSolved || 0,
        mediumSolved: battle.mediumSolved || 0,
        easySolved: battle.easySolved || 0,
        platforms: battle.platforms || { leetcode: 0, gfg: 0, codingninjas: 0 },
        createdAt: new Date().toISOString()
      });
      modified = true;
      console.log("[DsGit] 🔄 Synced new battle from Web:", battleId);
    }
  }

  if (modified) await saveBattles(battles);
}

// Ensure connection when Service Worker wakes up
connectWebSocket();

// ─── Install handler ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log("[DsGit] onInstalled:", reason);
  await scheduleReminder();
  await setupBattleAlarms();

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
    console.log("[DsGit] Snapshot sanitization done:", cleaned.length, "snaps");
  } catch (e) {
    console.warn("[DsGit] Snapshot sanitization failed:", e);
  }
});

// ─── Alarm handler — daily reminder ──────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BATTLES_POLL_ALARM) return pollBattlesHandler();
  if (alarm.name === ISSUES_POLL_ALARM) return pollIssuesHandler();
  if (alarm.name !== REMINDER_ALARM) return;

  const token = await getAccessToken();
  if (!token) return;

  const streak = await getStreakData();
  const today = todayISO();

  if (streak.lastPushDate !== today) {
    const dayNumber = await getCurrentDayNumber();
    chrome.notifications.create("daily-reminder", {
      type: "basic",
      iconUrl: "/assets/icons/icon-128.png",
      title: `🔥 DsGit — Day ${dayNumber}`,
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
  const now = new Date();
  const fire = new Date();
  fire.setHours(REMINDER_HOUR, 0, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);
  chrome.alarms.create(REMINDER_ALARM, { when: fire.getTime() });
}

async function setupBattleAlarms() {
  await chrome.alarms.clear(BATTLES_POLL_ALARM);
  await chrome.alarms.clear(ISSUES_POLL_ALARM);
  chrome.alarms.create(BATTLES_POLL_ALARM, { periodInMinutes: 360 });
  chrome.alarms.create(ISSUES_POLL_ALARM, { periodInMinutes: 30 });
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

    case "SEND_CHALLENGE":
      return sendChallenge(msg.payload);

    case "FETCH_FRIEND_STATS":
      return handleFetchFriendStats(msg.payload);

    case "ACCEPT_CHALLENGE":
      return acceptChallenge(msg.payload);

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ─── OAuth flow ───────────────────────────────────────────────────────────────

async function initiateGitHubOAuth() {
  const state = crypto.randomUUID();
  const authURL = new URL(GITHUB_AUTH_URL);
  authURL.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authURL.searchParams.set("redirect_uri", GITHUB_REDIRECT_URI);
  authURL.searchParams.set("scope", GITHUB_SCOPES);
  authURL.searchParams.set("state", state);

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authURL.toString(),
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
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

  // Sync to Backend
  try {
    await fetch('https://api-dsgit.onrender.com/api/sync-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubId: profile.id,
        username: profile.login,
        avatar_url: profile.avatar_url
      })
    });
    // Ensure WS is connected
    if (!wsIsConnected) connectWebSocket();
  } catch (e) {
    console.error("[DSA Tracker] Backend sync failed", e);
  }

  return { success: true, profile };
}

async function handleLogout() {
  await clearAccessToken();
  await clearUserProfile();
  return { success: true };
}

async function getAuthStatus() {
  try {
    const token = await getAccessToken();
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
  const today = todayISO();

  await ensureRepo(profile.login, repoName);

  const filePath = buildFilePath({ dayNumber, questionName, platformName: platform, difficulty, language });
  const fileContent = buildCodeFile({
    code, questionName, questionUrl,
    platform, difficulty, language,
    dayNumber, date: today,
  });

  const pushHistory = await getPushHistory();

  const alreadyPushedToday = pushHistory.some(entry =>
    entry.date === today &&
    entry.questionName === questionName &&
    entry.platform === platform
  );

  if (alreadyPushedToday) {
    throw new Error("ALREADY_PUSHED_TODAY");
  }

  const streakBefore = await getStreakData();

  const newEntry = {
    dayNumber, questionName, questionUrl,
    platform, difficulty, language,
    date: today, filePath, commitSHA: null,
  };

  const updatedReadme = buildReadme(profile, [newEntry, ...pushHistory], streakBefore);

  const commitMessage =
    `✅ Day-${dayNumber}: ${questionName} [${platform}]${difficulty ? ` — ${difficulty}` : ""}`;

  // Pre-calculate streak
  const lastPushDate = streakBefore.lastPushDate;
  let nextCurrent = lastPushDate ? streakBefore.currentStreak : 0;
  let nextLongest = streakBefore.longestStreak;
  if (lastPushDate) {
    const diffDays = Math.round((new Date(today) - new Date(lastPushDate)) / 86_400_000);
    if (diffDays > 1) nextCurrent = 1;
    else if (diffDays === 1) nextCurrent += 1;
  } else {
    nextCurrent = 1;
  }
  nextLongest = Math.max(nextLongest, nextCurrent);

  let battles = (await getBattles()) || [];
  const badges = (await getBadges()) || [];
  const signupDate = (await getSignupDate()) || today;

  // CRITICAL FIX: Sync battles from backend to ensure we have the latest
  try {
    const serverBattles = await fetch(
      `https://api-dsgit.onrender.com/battles/user/${profile.login}`
    ).then(r => r.json());
    if (serverBattles.success && serverBattles.battles) {
      // Merge server battles with local cache
      const battleMap = new Map(battles.map(b => [b.id, b]));
      serverBattles.battles.forEach(b => {
        battleMap.set(b.id, {
          id: b.id,
          type: b.type || 'standard',
          duration: b.duration || 7,
          opponent: b.opponent || 'Opponent',
          status: b.status || 'active',
          endDate: b.endDate || null
        });
      });
      battles = Array.from(battleMap.values());
      await saveBattles(battles);
      console.log("[DSA Tracker] Synced battles from server:", battles.length);
    }
  } catch (err) {
    console.warn("[DSA Tracker] Failed to sync battles from server:", err);
    // Continue with local cache
  }

  const statsObj = {
    username: profile.login,
    currentStreak: nextCurrent,
    longestStreak: nextLongest,
    totalSolved: pushHistory.length + 1,
    lastPushDate: today,
    signupDate,
    battles,
    badges,
  };
  const statsString = JSON.stringify(statsObj, null, 2);
  const betterReadme = buildReadme(profile, [newEntry, ...pushHistory], { currentStreak: nextCurrent, longestStreak: nextLongest, breaks: streakBefore.breaks }, badges, battles);

  const { commitSHA } = await pushFilesToRepo({
    owner: profile.login,
    repo: repoName,
    commitMessage,
    files: [
      { path: filePath, content: fileContent },
      { path: "README.md", content: betterReadme },
      { path: "stats.json", content: statsString },
    ],
  });

  newEntry.commitSHA = commitSHA;

  const streakAfter = await recordPush(today);
  await appendPushHistory(newEntry);

  const milestone = checkMilestone(streakAfter.currentStreak);

  // Broadcast activity to active battles via WebSocket
  if (ws && wsIsConnected) {
    const activeBattles = battles.filter(b => b.status === "active" || b.status === "pending_invite"); // Ensure we only send to active or open battles
    if (activeBattles.length > 0) {
      console.log("[DSA Tracker] Broadcasting to", activeBattles.length, "battles");
      for (const b of activeBattles) {
        const points = difficulty === 'Hard' ? 3 : difficulty === 'Medium' ? 2 : 1;
        ws.send(JSON.stringify({
          type: 'BATTLE_ACTIVITY',
          payload: {
            battleId: b.id,
            username: profile.login,
            questionName,
            platform,
            difficulty,
            points
          }
        }));
        console.log("[DSA Tracker] Sent BATTLE_ACTIVITY for", b.id, ":", questionName);
      }
    } else {
      console.warn("[DSA Tracker] No active battles to broadcast activity to");
    }
  } else {
    console.warn("[DSA Tracker] WebSocket not connected. Can't broadcast activity. ws:", !!ws, "connected:", wsIsConnected);
  }

  return {
    success: true,
    filePath,
    commitSHA,
    dayNumber,
    streak: streakAfter,
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

async function fetchFullUserBattles(username) {
  try {
    const res = await fetch(`https://api-dsgit.onrender.com/battles/user/${username}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.battles || [];
  } catch (e) {
    console.error("[DSA Tracker] Failed to fetch full battles from API:", e);
    return [];
  }
}

async function getPopupData() {
  const profile = await getUserProfile();
  const repoName = await getRepoName();
  const streakData = await getStreakData();
  const dayNumber = await getCurrentDayNumber();
  const signupDate = await getSignupDate();
  const pushHistory = (await getPushHistory()).slice(0, 10);
  const badges = await getBadges() || [];
  
  // Fetch fresh battle data from backend API + local storage
  let battles = [];
  try {
    if (profile?.login) {
      const freshBattles = await fetchFullUserBattles(profile.login);
      if (freshBattles && freshBattles.length > 0) {
        battles = freshBattles;
        // Also save to local storage for offline fallback
        await saveBattles(freshBattles);
      }
    }
  } catch (e) {
    console.error("[DSA Tracker] Failed to fetch fresh battles:", e);
  }
  
  // Fallback to local storage if API fetch failed
  if (!battles || battles.length === 0) {
    battles = (await getBattles()) || [];
  }

  return {
    profile,
    repoName,
    streakData,
    dayNumber,
    signupDate,
    recentPushes: pushHistory,
    battles,
    badges
  };
}

// ─── Battles Feature ─────────────────────────────────────────────────────────

async function handleFetchFriendStats({ friendUsername }) {
  const repoName = await getRepoName();
  const stats = await fetchUserStatsJSON(friendUsername, repoName);
  if (stats && stats.error === "NOT_FOUND") throw new Error(`${friendUsername} hasn't set up DSA Tracker yet!`);
  return { success: true, stats };
}

async function sendChallenge(payload) {
  const { opponent, type, duration } = payload;
  const profile = await getUserProfile();
  if (opponent.toLowerCase() === profile.login.toLowerCase()) throw new Error("You can't challenge yourself!");

  await handleFetchFriendStats({ friendUsername: opponent }); // ensure tracker is installed

  const battleId = `battle_` + Date.now().toString(36);

  if (ws && wsIsConnected) {
    ws.send(JSON.stringify({
      type: 'SEND_CHALLENGE',
      payload: { opponent, battleType: type, duration, battleId }
    }));
  } else {
    throw new Error("Cannot send challenge: Backend disconnected. Try again in a moment.");
  }

  const battles = (await getBattles()) || [];
  battles.push({
    id: battleId, type, opponent, status: "pending_invite",
    startDate: todayISO(), duration
  });
  await saveBattles(battles);

  return { success: true, battleId };
}

async function acceptChallenge(payload) {
  const { opponent, battleId, type, duration, challengerRepo } = payload;

  if (ws && wsIsConnected) {
    ws.send(JSON.stringify({
      type: 'ACCEPT_CHALLENGE',
      payload: { battleId }
    }));
  } else {
    throw new Error("Cannot accept challenge: Backend disconnected.");
  }

  chrome.notifications.create({
    type: "basic", iconUrl: "/assets/icons/icon-128.png",
    title: "⚔️ Battle Started!",
    message: `You've accepted the challenge against ${opponent}. Don't break your streak!`
  });

  return { success: true };
}

async function pollIssuesHandler() {
  // Deprecated: Backend via WebSockets manages issue polling instantly.
  return;
}

async function pollBattlesHandler() {
  const profile = await getUserProfile();
  if (!profile) return;
  const repoName = await getRepoName();
  let battles = (await getBattles()) || [];
  if (battles.length === 0) return;

  let modified = false;
  const today = todayISO();
  const myStats = await getStreakData();

  for (let b of battles) {
    if (b.status !== "active") continue;

    let myMissedDay = false;
    if (myStats.lastPushDate) {
      const diff = Math.round((new Date(today) - new Date(myStats.lastPushDate)) / 86400000);
      if (diff > 1) myMissedDay = true;
    } else {
      myMissedDay = true;
    }

    if (myMissedDay) {
      modified = true;
      b.status = "lost";

      if (ws && wsIsConnected) {
        ws.send(JSON.stringify({
          type: 'BATTLE_LOST',
          payload: { battleId: b.id }
        }));
      }

      chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "💔 Streak Broken!", message: `You missed a day and lost the battle against ${b.opponent}.` });
    }
  }

  if (modified) await saveBattles(battles);
}
