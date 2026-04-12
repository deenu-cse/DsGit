// ─── GitHub API Wrapper ───────────────────────────────────────────────────────
// Handles all GitHub REST API calls: auth, repo ops, file push, README update

import { GITHUB_API_BASE } from "./constants.js";
import { getAccessToken } from "./storage.js";

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function ghFetch(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("NOT_AUTHENTICATED");

  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `GitHub API error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** Fetch authenticated user profile */
export async function fetchAuthenticatedUser() {
  return ghFetch("/user");
}

// ─── Repo operations ──────────────────────────────────────────────────────────

/** Check if repo exists for current user */
export async function repoExists(owner, repoName) {
  try {
    await ghFetch(`/repos/${owner}/${repoName}`);
    return true;
  } catch (e) {
    if (e.message.includes("404") || e.message.includes("Not Found")) return false;
    throw e;
  }
}

/** Create a new repository for the user */
export async function createRepo(repoName) {
  return ghFetch("/user/repos", {
    method: "POST",
    body: {
      name: repoName,
      description: "🔥 DSA Practice — Daily consistency tracked by DSA Tracker Extension",
      private: false,
      auto_init: true, // Creates initial commit with README
    },
  });
}

/** Ensure repo exists, create if not */
export async function ensureRepo(owner, repoName) {
  const exists = await repoExists(owner, repoName);
  if (!exists) {
    await createRepo(repoName);
    // GitHub needs a moment after creation before API calls work
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ─── Git internals — commit pipeline ─────────────────────────────────────────

async function getLatestCommitSHA(owner, repo, branch = "main") {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  return data.object.sha;
}

async function getCommitTreeSHA(owner, repo, commitSHA) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/commits/${commitSHA}`);
  return data.tree.sha;
}

async function createBlob(owner, repo, content) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    body: {
      content: btoa(unescape(encodeURIComponent(content))), // UTF-8 safe base64
      encoding: "base64",
    },
  });
  return data.sha;
}

async function createTree(owner, repo, baseTreeSHA, files) {
  // files: Array<{ path: string, content: string }>
  const tree = files.map(f => ({
    path: f.path,
    mode: "100644",
    type: "blob",
    content: f.content,
  }));

  const data = await ghFetch(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSHA, tree },
  });
  return data.sha;
}

async function createCommit(owner, repo, message, treeSHA, parentSHA) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: {
      message,
      tree: treeSHA,
      parents: [parentSHA],
    },
  });
  return data.sha;
}

async function updateBranchRef(owner, repo, commitSHA, branch = "main") {
  return ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: { sha: commitSHA, force: false },
  });
}

// ─── High-level push function ─────────────────────────────────────────────────

/**
 * Push multiple files to a repo in a single atomic commit.
 * @param {object} params
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.commitMessage
 * @param {Array<{path: string, content: string}>} params.files
 * @param {string} [params.branch]
 */
export async function pushFilesToRepo({ owner, repo, commitMessage, files, branch = "main" }) {
  const latestCommitSHA = await getLatestCommitSHA(owner, repo, branch);
  const baseTreeSHA = await getCommitTreeSHA(owner, repo, latestCommitSHA);
  const newTreeSHA = await createTree(owner, repo, baseTreeSHA, files);
  const newCommitSHA = await createCommit(owner, repo, commitMessage, newTreeSHA, latestCommitSHA);
  await updateBranchRef(owner, repo, newCommitSHA, branch);
  return { commitSHA: newCommitSHA };
}

// ─── README builder ───────────────────────────────────────────────────────────

/**
 * Fetch existing README content from repo (decoded from base64).
 */
export async function fetchReadme(owner, repo) {
  try {
    const data = await ghFetch(`/repos/${owner}/${repo}/contents/README.md`);
    return {
      content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))),
      sha: data.sha,
    };
  } catch {
    return { content: null, sha: null };
  }
}

/**
 * Build the README table from push history.
 */
export function buildReadme(userProfile, pushHistory, streakData) {
  const { login, name, avatar_url } = userProfile;
  const displayName = name || login;

  const badge = getBadgeForStreak(streakData.longestStreak);

  const tableRows = pushHistory
    .slice(0, 200)
    .map(p =>
      `| ${p.dayNumber} | [${p.questionName}](${p.questionUrl || "#"}) | ${p.platform} | ${p.difficulty || "—"} | ${p.language} | ${p.date} |`
    )
    .join("\n");

  return `# 🔥 DSA Practice — ${displayName}

> Tracked by [DSA Tracker](https://github.com) Chrome Extension

---

## 📊 Stats

| 🔥 Current Streak | 🏆 Longest Streak | 📅 Total Questions | 💔 Breaks |
|:-:|:-:|:-:|:-:|
| **${streakData.currentStreak} days** | **${streakData.longestStreak} days** | **${pushHistory.length}** | **${streakData.breaks.length}** |

${badge ? `\n## 🏅 Achievement\n\n**${badge}**\n` : ""}

---

## 📝 Solutions Log

| Day | Question | Platform | Difficulty | Language | Date |
|:---:|:---------|:--------:|:----------:|:--------:|:----:|
${tableRows}

---

<sub>Auto-generated by DSA Tracker Extension • Last updated: ${new Date().toUTCString()}</sub>
`;
}

function getBadgeForStreak(streak) {
  const milestones = [
    [365, "🌟 365-Day God Mode"],
    [200, "🚀 200-Day Astronaut"],
    [100, "👑 100-Day King"],
    [60, "💎 60-Day Diamond"],
    [30, "🥇 30-Day Legend"],
    [14, "🥈 2-Week Champion"],
    [7, "🥉 7-Day Warrior"],
  ];
  for (const [days, label] of milestones) {
    if (streak >= days) return label;
  }
  return null;
}
