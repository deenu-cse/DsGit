# 🔥 DSA Tracker — Chrome Extension

> Auto-push DSA solutions to GitHub. Track streaks, build consistency — day by day.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🐙 GitHub OAuth | Secure login — password never touches extension |
| 📂 Auto-push on Submit | Code pushed the moment you get "Accepted" |
| 📅 Day numbering | Day-1, Day-2... from signup date, automatically |
| 🔥 Streak tracker | Current streak, longest streak, break detection |
| 💔 Break indicator | Red banner + missed date shown in popup |
| ⏪ Code Time Machine | Ctrl+Shift+Z restores last code snapshot |
| ⌨️ Manual push | Ctrl+Shift+G to push anytime |
| 📊 Heatmap | 30-day activity grid in popup |
| 🏆 Milestones | 7/14/30/60/100/200/365-day badges |
| 📤 Share card | Download streak card for LinkedIn/Twitter |
| 🔔 Daily reminder | 9 PM notification if you haven't pushed |
| 📁 Smart file naming | `TwoSum_LeetCode_Easy.py` — auto-detected |
| 📝 Auto README | Table updated on every push |

---

## 🏗 Folder Structure

```
dsa-tracker-extension/
├── manifest.json
├── assets/
│   └── icons/              ← icon-16/32/48/128.png (add your own)
└── src/
    ├── shared/
    │   ├── constants.js    ← All app constants
    │   ├── storage.js      ← chrome.storage wrapper + streak logic
    │   ├── github-api.js   ← All GitHub REST API calls
    │   └── utils.js        ← Platform detection, code extraction, UI utils
    ├── background/
    │   └── service-worker.js  ← OAuth, push pipeline, alarms
    ├── content/
    │   └── content-main.js   ← Injected into coding platforms
    ├── popup/
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.js
    └── options/
        └── options.html    ← Full settings page
```

---

## 🚀 Setup (Developer)

### 1. Create GitHub OAuth App

1. Go to [GitHub Settings → Developer Settings → OAuth Apps](https://github.com/settings/developers)
2. Click **"New OAuth App"**
3. Fill in:
   - **Application name**: DSA Tracker
   - **Homepage URL**: `https://github.com`
   - **Authorization callback URL**: `https://<YOUR_EXTENSION_ID>.chromiumapp.org/`
     > You get the extension ID after loading it in Chrome — see Step 3.
4. Copy your **Client ID** and **Client Secret**

### 2. Deploy Token Exchange Proxy

GitHub OAuth requires a **server** to exchange the `code` for an `access_token`
(because the Client Secret must stay private). Deploy a tiny proxy:

**Option A — Cloudflare Worker (free, recommended):**
```js
// worker.js
export default {
  async fetch(req) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const { code } = await req.json();
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method:  "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body:    JSON.stringify({
        client_id:     "YOUR_CLIENT_ID",
        client_secret: "YOUR_CLIENT_SECRET",
        code,
      }),
    });
    const data = await res.json();
    return Response.json(data, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
};
```

Deploy to Cloudflare Workers and update the proxy URL in `service-worker.js`:
```js
// Line in service-worker.js
const tokenRes = await fetch("https://YOUR_WORKER.workers.dev/auth/github", ...);
```

**Option B — Vercel Edge Function** (also free):
Same logic, deployed as `api/github.js` in a Vercel project.

### 3. Update Constants

In `src/shared/constants.js`:
```js
export const GITHUB_CLIENT_ID = "your_actual_client_id_here";
```

In `src/background/service-worker.js`:
```js
const tokenRes = await fetch("https://your-worker.workers.dev/auth/github", ...);
```

### 4. Load Extension in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer Mode** (top right)
3. Click **"Load unpacked"**
4. Select the `dsa-tracker-extension/` folder
5. Copy the **Extension ID** shown
6. Go back to GitHub OAuth App settings and update the callback URL:
   `https://<EXTENSION_ID>.chromiumapp.org/`

### 5. Add Icons

Place PNG icons in `assets/icons/`:
- `icon-16.png`
- `icon-32.png`
- `icon-48.png`
- `icon-128.png`

You can generate them from any 512×512 PNG using [favicon.io](https://favicon.io/).

---

## 📖 How it works

```
Student opens LeetCode → content_script.js injected
      ↓
Student solves question, clicks Submit
      ↓
content_script detects "Accepted" result
      ↓
sendMessage("PUSH_SOLUTION") → service-worker.js
      ↓
service-worker: ensureRepo → buildFilePath → buildCodeFile
      ↓
GitHub API: get latest commit → create tree → create commit → update ref
      ↓
Streak updated, README rebuilt and pushed in same commit
      ↓
Toast shown: "✅ Pushed! Day-14 → GitHub 🔥 Streak: 14 days"
```

---

## 🔑 Permissions explained

| Permission | Why |
|---|---|
| `identity` | Chrome's built-in OAuth flow |
| `storage` | Save token, streak, snapshots locally |
| `notifications` | Daily 9 PM reminder |
| `alarms` | Schedule daily reminder |
| `host_permissions (api.github.com)` | Make GitHub API calls |
| `host_permissions (leetcode.com etc)` | Inject content script |

---

## 🛡 Privacy

- Your code and GitHub token are stored **locally** in `chrome.storage.local` only
- Nothing is sent to any third-party server except GitHub's API and your own proxy
- The proxy only handles the OAuth code→token exchange and holds no state

---

## 📄 License

MIT — build on it, improve it, share it.
