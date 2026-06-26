// ─── Storage Utility — typed wrapper around chrome.storage.local ─────────────

import { STORAGE_KEYS } from "./constants.js";

// ─── Generic get/set helpers ──────────────────────────────────────────────────

export async function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key] ?? null));
  });
}

export async function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

export async function storageRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, resolve);
  });
}

// ─── Typed helpers ────────────────────────────────────────────────────────────

export async function getAccessToken() { return storageGet(STORAGE_KEYS.ACCESS_TOKEN); }
export async function setAccessToken(token) { return storageSet(STORAGE_KEYS.ACCESS_TOKEN, token); }
export async function clearAccessToken() { return storageRemove(STORAGE_KEYS.ACCESS_TOKEN); }

export async function getUserProfile() { return storageGet(STORAGE_KEYS.USER_PROFILE); }
export async function setUserProfile(profile) { return storageSet(STORAGE_KEYS.USER_PROFILE, profile); }
export async function clearUserProfile() { return storageRemove(STORAGE_KEYS.USER_PROFILE); }

export async function getRepoName() { return storageGet(STORAGE_KEYS.REPO_NAME); }
export async function setRepoName(name) { return storageSet(STORAGE_KEYS.REPO_NAME, name); }

export async function getSignupDate() { return storageGet(STORAGE_KEYS.SIGNUP_DATE); }
export async function setSignupDate(iso) { return storageSet(STORAGE_KEYS.SIGNUP_DATE, iso); }

export async function getSettings() { return storageGet(STORAGE_KEYS.SETTINGS); }
export async function saveSettings(s) { return storageSet(STORAGE_KEYS.SETTINGS, s); }

export async function getBattles() { return storageGet(STORAGE_KEYS.BATTLES); }
export async function saveBattles(b) { return storageSet(STORAGE_KEYS.BATTLES, b); }

export async function getBadges() { return storageGet(STORAGE_KEYS.BADGES); }
export async function saveBadges(b) { return storageSet(STORAGE_KEYS.BADGES, b); }

export async function getStatsCache() { return storageGet(STORAGE_KEYS.STATS_CACHE); }
export async function saveStatsCache(c) { return storageSet(STORAGE_KEYS.STATS_CACHE, c); }

// ── BUG FIX: must AWAIT storageGet before applying ?? [] ─────────────────────
export async function getPushHistory() {
  const val = await storageGet(STORAGE_KEYS.PUSH_HISTORY);
  return val ?? [];
}

export async function getSnapshots() {
  const val = await storageGet(STORAGE_KEYS.SNAPSHOTS);
  return val ?? [];
}

export async function saveSnapshots(snaps) {
  return storageSet(STORAGE_KEYS.SNAPSHOTS, snaps);
}

// ─── Streak data ──────────────────────────────────────────────────────────────

/** @returns {{ currentStreak, longestStreak, lastPushDate, history, breaks }} */
export async function getStreakData() {
  const val = await storageGet(STORAGE_KEYS.STREAK_DATA);
  return val ?? {
    currentStreak: 0,
    longestStreak: 0,
    lastPushDate: null,
    history: [],   // Array<{ date: "YYYY-MM-DD", count: number }>
    breaks: [],   // Array<"YYYY-MM-DD"> — days where no push happened
  };
}

export async function saveStreakData(data) {
  return storageSet(STORAGE_KEYS.STREAK_DATA, data);
}

/**
 * Called after every successful push.
 * Updates streak, history, detects breaks.
 */
export async function recordPush(dateISO) {
  const streak = await getStreakData();
  const today = dateISO.slice(0, 10); // "YYYY-MM-DD"

  if (streak.lastPushDate) {
    // Parse dates carefully — append T00:00:00 to avoid timezone shifts
    const last = new Date(streak.lastPushDate + "T00:00:00");
    const curr = new Date(today + "T00:00:00");
    const diffDays = Math.round((curr - last) / 86_400_000);

    if (diffDays > 1) {
      // Broke the streak — record each missed day using LOCAL date format
      for (let d = 1; d < diffDays; d++) {
        const missed = new Date(last);
        missed.setDate(missed.getDate() + d);
        const yyyy = missed.getFullYear();
        const mm = String(missed.getMonth() + 1).padStart(2, '0');
        const dd = String(missed.getDate()).padStart(2, '0');
        streak.breaks.push(`${yyyy}-${mm}-${dd}`);
      }
      streak.currentStreak = 1; // reset
    } else if (diffDays === 1) {
      streak.currentStreak += 1;
    }
    // diffDays === 0 → same day, multiple pushes — don't double count
  } else {
    streak.currentStreak = 1;
  }

  streak.longestStreak = Math.max(streak.longestStreak, streak.currentStreak);
  streak.lastPushDate = today;

  // Upsert today in history
  const existingIdx = streak.history.findIndex(h => h.date === today);
  if (existingIdx >= 0) {
    streak.history[existingIdx].count += 1;
  } else {
    streak.history.push({ date: today, count: 1 });
  }

  await saveStreakData(streak);
  return streak;
}

/**
 * Append one entry to push history (full log).
 */
export async function appendPushHistory(entry) {
  const history = await getPushHistory();
  history.unshift(entry); // newest first
  if (history.length > 500) history.length = 500;
  return storageSet(STORAGE_KEYS.PUSH_HISTORY, history);
}

// ─── Day number ───────────────────────────────────────────────────────────────

/**
 * Helper: get today's date in LOCAL timezone as "YYYY-MM-DD".
 * Must match todayISO() in utils.js — we duplicate here to avoid circular imports.
 */
function localToday() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the current day number based on unique submission dates.
 * Day 1 = first ever push day, Day 2 = second unique push day, etc.
 * Uses BOTH pushHistory AND streakData.history for robustness —
 * if push history is ever truncated/cleared, streak history still has the dates.
 */
export async function getCurrentDayNumber() {
  const history = await getPushHistory();
  const streak = await getStreakData();

  // Merge unique dates from both push history and streak history
  const pushDates = (history || []).map(e => e.date).filter(Boolean);
  const streakDates = (streak.history || []).map(h => h.date).filter(Boolean);
  const allDates = [...new Set([...pushDates, ...streakDates])].sort();

  if (allDates.length === 0) return 1;

  const today = localToday();

  if (allDates.includes(today)) {
    return allDates.indexOf(today) + 1;
  } else {
    return allDates.length + 1;
  }
}
