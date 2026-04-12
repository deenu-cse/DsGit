// ─── GitHub OAuth Token Exchange Worker ──────────────────────────────────────
// Deploy on Cloudflare Workers
// Replace YOUR_CLIENT_ID and YOUR_CLIENT_SECRET with your GitHub OAuth App values

const GITHUB_CLIENT_ID     = "YOUR_CLIENT_ID";      // ← apna daal
const GITHUB_CLIENT_SECRET = "YOUR_CLIENT_SECRET";  // ← apna daal

// Allowed origins — apni extension ID daal
const ALLOWED_ORIGINS = [
  "chrome-extension://YOUR_EXTENSION_ID",  // ← apna extension ID daal
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") ?? "";

    // ── Preflight (OPTIONS) ──────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // ── Only POST allowed ────────────────────────────────────────────────────
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders(origin),
      });
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let code;
    try {
      const body = await request.json();
      code = body.code;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    if (!code) {
      return new Response(JSON.stringify({ error: "Missing code parameter" }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    // ── Exchange code for token with GitHub ──────────────────────────────────
    try {
      const ghResponse = await fetch("https://github.com/login/oauth/access_token", {
        method:  "POST",
        headers: {
          "Accept":       "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id:     GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const data = await ghResponse.json();

      // GitHub returns error in body (not HTTP status)
      if (data.error) {
        return new Response(JSON.stringify({ error: data.error_description ?? data.error }), {
          status: 400,
          headers: corsHeaders(origin),
        });
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: corsHeaders(origin),
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "GitHub API call failed", detail: err.message }), {
        status: 500,
        headers: corsHeaders(origin),
      });
    }
  },
};
