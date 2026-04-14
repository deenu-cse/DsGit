// ─── App Constants ───────────────────────────────────────────────────────────

export const APP_NAME = "DSA Tracker";
export const VERSION = "1.0.0";

// GitHub OAuth — replace with your GitHub OAuth App credentials
export const GITHUB_CLIENT_ID = "Ov23liTS6XnZTy9c7qIz";
export const GITHUB_CLIENT_SECRET = "82a8248ff9f8cd958456ec7833b501ce552548cf";
export const GITHUB_REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
export const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_SCOPES = "repo user:email read:user";

// Storage keys
export const STORAGE_KEYS = {
  ACCESS_TOKEN: "gh_access_token",
  USER_PROFILE: "gh_user_profile",
  REPO_NAME: "target_repo_name",
  SIGNUP_DATE: "signup_date",           // ISO string — day counting starts from here
  STREAK_DATA: "streak_data",           // { currentStreak, longestStreak, lastPushDate, history: [] }
  SETTINGS: "user_settings",
  SNAPSHOTS: "code_snapshots",        // Code Time Machine snapshots
  PUSH_HISTORY: "push_history",          // Array of all pushes
  BATTLES: "dsa_battles",             // Active and past battles
  BADGES: "dsa_badges",               // Unlocked battle badges
  STATS_CACHE: "dsa_stats_cache",     // Cache for friend's stats.json
};

// Platform detection config
export const PLATFORMS = {
  LEETCODE: {
    id: "leetcode",
    name: "LeetCode",
    color: "#FFA116",
    hostPattern: /leetcode\.com/,
    editorType: "monaco",
    // Selectors to detect submit success
    submitBtn: '[data-e2e-locator="console-submit-button"]',
    successIndicator: '[data-e2e-locator="submission-result"]',
  },
  GFG: {
    id: "gfg",
    name: "GeeksForGeeks",
    color: "#2F8D46",
    hostPattern: /geeksforgeeks\.org/,
    editorType: "codemirror",
    submitBtn: "button.submit",
    successIndicator: ".problems-tab-section",
  },
  CODING_NINJAS: {
    id: "codingninjas",
    name: "Coding Ninjas",
    color: "#E94F37",
    hostPattern: /codingninjas\.com/,
    editorType: "monaco",
    submitBtn: "button.submit-button",
    successIndicator: ".submission-result",
  },
};

// Language → file extension map
export const LANG_EXTENSIONS = {
  python: "py",
  python3: "py",
  java: "java",
  javascript: "js",
  typescript: "ts",
  cpp: "cpp",
  "c++": "cpp",
  c: "c",
  go: "go",
  rust: "rs",
  kotlin: "kt",
  swift: "swift",
  ruby: "rb",
  csharp: "cs",
  "c#": "cs",
  scala: "scala",
  php: "php",
};

// Difficulty labels
export const DIFFICULTIES = {
  easy: { label: "Easy", emoji: "🟢" },
  medium: { label: "Medium", emoji: "🟡" },
  hard: { label: "Hard", emoji: "🔴" },
};

// Streak milestone badges
export const STREAK_MILESTONES = [
  { days: 7, badge: "🥉 7-Day Warrior", color: "#CD7F32" },
  { days: 14, badge: "🥈 2-Week Champion", color: "#C0C0C0" },
  { days: 30, badge: "🥇 30-Day Legend", color: "#FFD700" },
  { days: 60, badge: "💎 60-Day Diamond", color: "#00BFFF" },
  { days: 100, badge: "👑 100-Day King", color: "#FF69B4" },
  { days: 200, badge: "🚀 200-Day Astronaut", color: "#9B59B6" },
  { days: 365, badge: "🌟 365-Day God Mode", color: "#FF4500" },
];

// Reminder alarm name
export const REMINDER_ALARM = "daily_reminder";
export const BATTLES_POLL_ALARM = "poll_battles";
export const ISSUES_POLL_ALARM = "poll_issues";
export const REMINDER_HOUR = 21; // 9 PM

// Snapshot settings (Code Time Machine)
export const SNAPSHOT_INTERVAL_MS = 30_000; // 30 seconds
export const MAX_SNAPSHOTS = 10;
export const RESTORE_SHORTCUT = { ctrlKey: true, shiftKey: true, key: "Z" };
