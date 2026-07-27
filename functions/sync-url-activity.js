// Cloudflare Pages Function: /functions/sync-url-activity.js
// Receives automatic browser activity (domain + time spent) reported by the AMC Tracker
// Chrome extension and merges it into GitHub's url-activity.json using a server-side PAT secret.
// One record per person per domain per day; seconds accumulate across repeated calls.
// Requires GITHUB_PAT environment variable configured in Cloudflare Pages settings.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestPost(context) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const MAX_RETRIES = 4;
    const { request, env } = context;

  try {
        const body = await request.json();
        const { email, date, domain, url, title, seconds, _clientPat } = body;
        const pat = env.GITHUB_PAT || _clientPat || '';
        if (!pat) {
                return new Response(JSON.stringify({ error: 'GITHUB_PAT not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!email || !date || !domain) {
                return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const sec = Math.max(0, Math.min(3600, Number(seconds) || 0));

      const owner = 'AmericanMedicalCompliance';
        const repo = 'amc-tracker';
        const file = 'url-activity.json';
        const apiBase = 'https://api.github.com';

      async function doMergeAndWrite(attempt = 0) {
              const fileResp = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${file}?ref=classic-tracker`, {
                        headers: { Authorization: `token ${pat}`, 'User-Agent': 'amc-tracker' },
              });

          let existing = [];
              let currentSha;
              if (fileResp.status === 200) {
                        const fileData = await fileResp.json();
                        currentSha = fileData.sha;
                        if (fileData.content) {
                                    try {
                                                  existing = JSON.parse(atob(fileData.content.split('\n').join('')));
                                    } catch (e) {
                                                  existing = [];
                                    }
                        }
              } else if (fileResp.status !== 404) {
                        return { error: 'GITHUB_READ_FAILED', status: 502 };
              }

          const emailLower = String(email).toLowerCase();
              const idx = existing.findIndex((r) => r.email === emailLower && r.date === date && r.domain === domain);
              const nowIso = new Date().toISOString();
              if (idx >= 0) {
                        existing[idx].seconds = (existing[idx].seconds || 0) + sec;
                        existing[idx].count = (existing[idx].count || 0) + 1;
                        existing[idx].url = url || existing[idx].url;
                        existing[idx].title = title || existing[idx].title;
                        existing[idx].updated = nowIso;
              } else {
                        existing.push({ email: emailLower, date, domain, url: url || '', title: title || '', seconds: sec, count: 1, updated: nowIso });
              }

          const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(existing))));
              const putResp = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${file}`, {
                        method: 'PUT',
                        headers: { Authorization: `token ${pat}`, 'User-Agent': 'amc-tracker', 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                                    message: `Update url-activity for ${emailLower} [skip ci]`,
                                    content: encoded,
                                    sha: currentSha,
                                    branch: 'classic-tracker',
                        }),
              });

          if (putResp.status === 409 || putResp.status === 422) {
                    if (attempt < MAX_RETRIES) {
                                await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
                                return doMergeAndWrite(attempt + 1);
                    }
                    return { error: 'RATE_LIMITED', status: 429 };
          }
              if (!putResp.ok) {
                        const errText = await putResp.text();
                        return { error: 'GITHUB_WRITE_FAILED', detail: errText, status: 502 };
              }
              return { ok: true };
      }

      const result = await doMergeAndWrite(0);
        if (result.error) {
                return new Response(JSON.stringify(result), { status: result.status || 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
        return new Response(JSON.stringify({ error: 'SERVER_ERROR', detail: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

export async function onRequestOptions() {
    return new Response(null, {
          status: 204,
          headers: corsHeaders,
    });
}
