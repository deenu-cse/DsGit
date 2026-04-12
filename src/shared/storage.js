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
    const last = new Date(streak.lastPushDate);
    const curr = new Date(today);
    const diffDays = Math.round((curr - last) / 86_400_000);

    if (diffDays > 1) {
      // Broke the streak — record each missed day
      for (let d = 1; d < diffDays; d++) {
        const missed = new Date(last);
        missed.setDate(missed.getDate() + d);
        streak.breaks.push(missed.toISOString().slice(0, 10));
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

export async function getCurrentDayNumber() {
  const signupDate = await getSignupDate();
  if (!signupDate) return 1;
  const start = new Date(signupDate);
  const now = new Date();
  const diff = Math.floor((now - start) / 86_400_000);
  return diff + 1;
}
