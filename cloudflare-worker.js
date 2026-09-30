// Bingo Calculator — prize-sheet proxy
//
// This Worker sits between your published page and Anthropic's API.
// It holds your API key (as a secret, never shown to visitors) and
// limits each visitor to 2 prize-sheet reads per 6 hours.
//
// Setup steps are in the instructions doc — the two things you must
// fill in below are marked with "CHANGE ME".

const ALLOWED_ORIGIN = "https://CHANGE-ME.github.io"; // CHANGE ME: your GitHub Pages origin, no trailing slash or path
const RATE_LIMIT = 2;
const WINDOW_SECONDS = 6 * 60 * 60; // 6 hours

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    // --- Rate limit: keyed by visitor IP, tracked in Workers KV ---
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = `ratelimit:${ip}`;
    const now = Date.now();

    const existingRaw = await env.RATE_LIMIT_KV.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    let count = 0;
    let windowStart = now;
    if (existing && now - existing.windowStart < WINDOW_SECONDS * 1000) {
      count = existing.count;
      windowStart = existing.windowStart;
    }

    if (count >= RATE_LIMIT) {
      const retryAfterSeconds = Math.ceil((windowStart + WINDOW_SECONDS * 1000 - now) / 1000);
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          message: "You've used both prize-sheet imports for this 6-hour window. Try again later, or enter the numbers by hand.",
          retryAfterSeconds,
        }),
        {
          status: 429,
          headers: { ...headers, "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
        }
      );
    }

    const newCount = count + 1;
    const ttlSeconds = existing
      ? Math.max(60, Math.ceil((windowStart + WINDOW_SECONDS * 1000 - now) / 1000))
      : WINDOW_SECONDS;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify({ count: newCount, windowStart }), {
      expirationTtl: ttlSeconds,
    });

    // --- Forward the request to Anthropic, adding the real API key server-side ---
    const body = await request.text();
    let anthropicResponse;
    try {
      anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "upstream_error", message: String(err) }), {
        status: 502,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const responseBody = await anthropicResponse.text();
    return new Response(responseBody, {
      status: anthropicResponse.status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
