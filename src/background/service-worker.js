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
  buildReadme, createIssue, addIssueComment, closeIssue,
  fetchRepositoryIssues, fetchUserStatsJSON, searchIssues,
  fetchIssueComments,
} from "../shared/github-api.js";

import {
  buildFilePath, buildCodeFile, todayISO,
} from "../shared/utils.js";

// ─── Install handler ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  console.log("[DSA Tracker] onInstalled:", reason);
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
    console.log("[DSA Tracker] Snapshot sanitization done:", cleaned.length, "snaps");
  } catch (e) {
    console.warn("[DSA Tracker] Snapshot sanitization failed:", e);
  }
});

// ─── Alarm handler — daily reminder ──────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BATTLES_POLL_ALARM) return pollBattlesHandler();
  if (alarm.name === ISSUES_POLL_ALARM) return pollIssuesHandler();
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

  const battles = (await getBattles()) || [];
  const badges = (await getBadges()) || [];
  const signupDate = (await getSignupDate()) || today;

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
    owner:         profile.login,
    repo:          repoName,
    commitMessage,
    files: [
      { path: filePath,     content: fileContent },
      { path: "README.md",  content: betterReadme },
      { path: "stats.json", content: statsString },
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
  const battles     = await getBattles() || [];
  const badges      = await getBadges() || [];

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
  const repoName = await getRepoName();
  if (opponent.toLowerCase() === profile.login.toLowerCase()) throw new Error("You can't challenge yourself!");
  
  await handleFetchFriendStats({ friendUsername: opponent }); // ensure repo exists

  const title = `DSA Battle Challenge from @${profile.login}`;
  const battleId = `battle_` + Date.now().toString(36);
  const body = `CHALLENGE::${type}::duration:${duration}::id:${battleId}::opponent:${opponent}`;

  const issueRes = await createIssue(profile.login, repoName, title, body);

  const battles = (await getBattles()) || [];
  battles.push({
    id: battleId, type, opponent, status: "pending_invite",
    issueNumber: issueRes.number,
    challengerRepo: profile.login,
    startDate: todayISO(), duration 
  });
  await saveBattles(battles);

  return { success: true, battleId };
}

async function acceptChallenge(payload) {
  const { opponent, battleId, issueNumber, type, duration, challengerRepo } = payload;
  const repoName = await getRepoName();

  await addIssueComment(challengerRepo, repoName, issueNumber, `ACCEPTED::${battleId}`);

  const battles = (await getBattles()) || [];
  
  // Clean up if it was a received_invite
  const idx = battles.findIndex(b => b.id === battleId);
  if (idx !== -1) battles.splice(idx, 1);

  battles.push({
    id: battleId, type, opponent, status: "active", issueNumber: String(issueNumber), challengerRepo: challengerRepo,
    startDate: todayISO(), endDate: new Date(Date.now() + parseInt(duration) * 86_400_000).toISOString().slice(0, 10),
  });
  await saveBattles(battles);
  
  chrome.notifications.create({
    type: "basic", iconUrl: "/assets/icons/icon-128.png",
    title: "⚔️ Battle Started!",
    message: `You've accepted the challenge against ${opponent}. Don't break your streak!`
  });

  return { success: true };
}

async function pollIssuesHandler() {
  const profile = await getUserProfile();
  if (!profile) return;
  const repoName = await getRepoName();
  let modified = false;
  let battles = (await getBattles()) || [];

  // Search globally for incoming challenges: "CHALLENGE:: opponent:MY_USER is:open"
  try {
     const query = `CHALLENGE:: opponent:${profile.login} is:open`;
     const results = await searchIssues(query);
     let newCount = 0;

     if (results && results.items) {
       for (const issue of results.items) {
         const b = issue.body || "";
         if (!b.includes(`opponent:${profile.login}`)) continue;

         const matchId = b.match(/id:(battle_[a-z0-z0-9]+)/);
         if (!matchId) continue;
         const battleId = matchId[1];

         if (battles.some(x => x.id === battleId)) continue; // Already tracked

         const matchType = b.match(/CHALLENGE::([a-z0-9-]+)::/);
         const matchDur = b.match(/duration:(\d+)/);

         battles.push({
           id: battleId,
           type: matchType ? matchType[1] : "unknown",
           duration: matchDur ? matchDur[1] : 30,
           opponent: issue.user.login,
           status: "received_invite",
           issueNumber: issue.number,
           challengerRepo: issue.user.login,
         });
         newCount++;
         modified = true;
       }
     }
     
     if (newCount > 0) {
        chrome.notifications.create({
          type: "basic", iconUrl: "/assets/icons/icon-128.png",
          title: "⚔️ New DSA Challenge!",
          message: `You received ${newCount} new battle challenge(s). Open DSA Tracker to accept!`
        });
     }
  } catch (e) {
     console.error("[DSA Tracker] Error polling issues:", e);
  }

  // Poll active/pending battles for comments (Acceptance / Losses)
  for (const b of battles) {
     try {
       if (b.status === "pending_invite" || b.status === "active") {
         const comments = await fetchIssueComments(b.challengerRepo, repoName, b.issueNumber);
         if (!comments) continue;

         for (const c of comments) {
           const body = c.body || "";
           if (b.status === "pending_invite" && body.includes(`ACCEPTED::${b.id}`)) {
             b.status = "active";
             b.endDate = new Date(Date.now() + parseInt(b.duration || 30) * 86_400_000).toISOString().slice(0, 10);
             modified = true;
             chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "⚔️ Challenge Accepted!", message: `${b.opponent} accepted your challenge. Let the battle begin!` });
           } 
           else if (b.status === "active" && body.includes(`BATTLE_RESULT::LOSER::${b.id}`) && c.user.login === b.opponent) {
             b.status = "won";
             modified = true;
             chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "🏆 Battle Won!", message: `${b.opponent} broke their streak! You win the battle.` });
           }
         }
       }
     } catch (e) {}
  }

  if (modified) await saveBattles(battles);
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
         try {
           await addIssueComment(b.challengerRepo || profile.login, repoName, b.issueNumber, `BATTLE_RESULT::LOSER::${b.id}`);
           await closeIssue(b.challengerRepo || profile.login, repoName, b.issueNumber);
         } catch (e) {}
         chrome.notifications.create({ type: "basic", iconUrl: "/assets/icons/icon-128.png", title: "💔 Streak Broken!", message: `You missed a day and lost the battle against ${b.opponent}.` });
      }
   }

   if (modified) await saveBattles(battles);
}
