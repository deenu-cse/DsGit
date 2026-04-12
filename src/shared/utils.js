// ─── Utility Functions ────────────────────────────────────────────────────────

import { LANG_EXTENSIONS, PLATFORMS } from "./constants.js";

// ─── Platform detection ───────────────────────────────────────────────────────

export function detectPlatform(url = window.location.href) {
  for (const platform of Object.values(PLATFORMS)) {
    if (platform.hostPattern.test(url)) return platform;
  }
  return null;
}

// ─── Question metadata extraction ────────────────────────────────────────────

/**
 * Extract question name from page title.
 * LeetCode: "Two Sum - LeetCode" → "Two Sum"
 * GFG:      "Two Sum | Practice | GeeksforGeeks" → "Two Sum"
 */
export function extractQuestionName(title = document.title) {
  return title
    .split(/[-|–—]/)
    .map(s => s.trim())
    .filter(s => s && !/(leetcode|geeksforgeeks|gfg|coding ninja|practice|problem)/i.test(s))[0]
    ?? "Unknown Question";
}

/**
 * Slugify a question name for use in file paths.
 * "Two Sum" → "TwoSum"
 */
export function slugify(name) {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Extract difficulty from page.
 * Returns "Easy" | "Medium" | "Hard" | null
 */
export function extractDifficulty() {
  const selectors = [
    // LeetCode
    '[class*="difficulty"]',
    '[data-difficulty]',
    // GFG
    '.difficulty',
    '.problems-difficulty-type',
    // Generic
    '[class*="Difficulty"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = el.textContent.trim().toLowerCase();
    if (text.includes("easy")) return "Easy";
    if (text.includes("medium")) return "Medium";
    if (text.includes("hard")) return "Hard";
  }
  return null;
}

/**
 * Detect the currently selected language from editor UI.
 */
export function extractLanguage() {
  const selectors = [
    // LeetCode language selector
    '[class*="Select__control"]',
    '[class*="lang-select"]',
    'div[data-track-load="description_content"] + div select',
    // GFG
    '#languageDropdown',
    '#programLang',
    // Generic select with language options
    'select[name="language"]',
    'select[name="lang"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = (el.textContent || el.value || "").trim().toLowerCase();
    if (text) return normalizeLanguage(text);
  }
  return "txt";
}

export function normalizeLanguage(raw) {
  const r = raw.toLowerCase().trim();
  const map = {
    python3: "python", py: "python", python: "python",
    java: "java",
    javascript: "javascript", js: "javascript",
    typescript: "typescript", ts: "typescript",
    "c++": "cpp", cpp: "cpp",
    "c": "c",
    golang: "go", go: "go",
    rust: "rust",
    kotlin: "kotlin",
    swift: "swift",
    ruby: "ruby",
    "c#": "csharp", csharp: "csharp",
    scala: "scala",
    php: "php",
  };
  return map[r] ?? "txt";
}

export function langToExtension(lang) {
  return LANG_EXTENSIONS[lang] ?? lang;
}

// ─── File path builder ────────────────────────────────────────────────────────

/**
 * Build the file path for a solution.
 * Example: "day-14/TwoSum_LeetCode_Easy.py"
 */
export function buildFilePath({ dayNumber, questionName, platformName, difficulty, language }) {
  const slug = slugify(questionName);
  const ext = langToExtension(normalizeLanguage(language));
  const diff = difficulty ? `_${difficulty}` : "";
  const plat = platformName ? `_${platformName.replace(/\s+/g, "")}` : "";
  return `day-${dayNumber}/${slug}${plat}${diff}.${ext}`;
}

// ─── Code file header builder ─────────────────────────────────────────────────

/**
 * Prepend a metadata comment to the student's code.
 */
export function buildCodeFile({ code, questionName, questionUrl, platform, difficulty, language, dayNumber, date }) {
  const commentChar = getCommentChar(language);
  const header = [
    `${commentChar} ═══════════════════════════════════════════════════`,
    `${commentChar}  DSA Tracker — Auto-pushed by Extension`,
    `${commentChar} ═══════════════════════════════════════════════════`,
    `${commentChar}  Question  : ${questionName}`,
    `${commentChar}  URL       : ${questionUrl || "N/A"}`,
    `${commentChar}  Platform  : ${platform}`,
    `${commentChar}  Difficulty: ${difficulty || "N/A"}`,
    `${commentChar}  Language  : ${language}`,
    `${commentChar}  Day       : Day-${dayNumber}`,
    `${commentChar}  Date      : ${date}`,
    `${commentChar} ═══════════════════════════════════════════════════`,
    "",
  ].join("\n");
  return header + code;
}

function getCommentChar(lang) {
  const hashLangs = ["python", "ruby", "go", "bash"];
  return hashLangs.includes(lang) ? "#" : "//";
}

// ─── Date utilities ───────────────────────────────────────────────────────────

export function todayISO() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86_400_000);
}

// ─── Monaco / CodeMirror code extraction ─────────────────────────────────────

/**
 * Extract code from Monaco editor (LeetCode, Coding Ninjas).
 */
export function getMonacoCode() {
  try {
    // Only use the real Monaco API — NEVER read .view-lines (virtual scroll,
    // only returns visible lines and corrupts spaces with \u00a0)
    const editors = window.monaco?.editor?.getEditors?.();
    if (editors?.length) return editors[0].getValue() || null;
  } catch (_) { }
  return null;
}

/**
 * Extract code from CodeMirror editor (GFG).
 */
export function getCodeMirrorCode() {
  try {
    const cmEl = document.querySelector(".CodeMirror");
    return cmEl?.CodeMirror?.getValue?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Set code in Monaco editor (for Time Machine restore).
 */
export function setMonacoCode(code) {
  try {
    const editors = window.monaco?.editor?.getEditors?.();
    if (!editors?.length) return false;
    const editor = editors[0];
    const model = editor.getModel();
    if (model) {
      // pushEditOperations preserves correct spacing (no \u00a0 corruption)
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: code }],
        () => null
      );
      editor.setScrollTop(0);
      editor.focus();
    } else {
      editor.setValue(code);
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function showToast(message, type = "success") {
  const existing = document.getElementById("dsa-tracker-toast");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.id = "dsa-tracker-toast";
  el.textContent = message;

  const colors = {
    success: { bg: "#1D9E75", text: "#fff" },
    error: { bg: "#E24B4A", text: "#fff" },
    info: { bg: "#378ADD", text: "#fff" },
    warning: { bg: "#BA7517", text: "#fff" },
  };
  const c = colors[type] ?? colors.success;

  Object.assign(el.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    background: c.bg,
    color: c.text,
    padding: "12px 20px",
    borderRadius: "10px",
    fontSize: "14px",
    fontFamily: "system-ui, sans-serif",
    fontWeight: "500",
    zIndex: "999999",
    boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
    transition: "opacity 0.3s ease",
    maxWidth: "320px",
    lineHeight: "1.5",
  });

  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 350);
  }, 3500);
}
