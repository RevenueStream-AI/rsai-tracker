// Cloudflare Pages Function: /functions/sync-sessions.js
// Syncs a user's time-tracking sessions to GitHub's sessions.json using a server-side PAT secret.
// Called by the RSAI Tracker app whenever sessions are updated for the current user.
// Requires GITHUB_PAT environment variable set in Cloudflare Pages settings.

export async function onRequestPost(context) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_RETRIES = 4;
  const { request, env } = context;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

try {
  const body = await request.json();
  const { uid, sessions, _clientPat } = body;
  const pat = env.GITHUB_PAT || _clientPat || '';
  if (!pat) {
    return new Response(JSON.stringify({ error: 'GITHUB_PAT not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (uid === undefined || uid === null || !sessions || !Array.isArray(sessions)) {
    return new Response(JSON.stringify({ error: 'Invalid sessions data' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const owner = 'RevenueStream-AI';
    const repo = 'rsai-tracker';
  const file = 'sessions.json';
  const apiBase = 'https://api.github.com';

  async function doMergeAndWrite(attempt = 0) {
    const fileResp = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${file}?ref=classic-tracker`, {
      headers: {
        Authorization: `token ${pat}`,
        Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'RSAI-Tracker-App',
      },
    });

  if (!fileResp.ok) {
      if (attempt < MAX_RETRIES) {
        await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
        return doMergeAndWrite(attempt + 1);
      }
      return { error: 'Failed to fetch current sessions file', status: 500 };
    }

  const fileData = await fileResp.json();
    const currentSha = fileData.sha;
    let existing = [];
    if (fileData.content) {
      try {
        existing = JSON.parse(atob(fileData.content.split('\n').join('')));
      } catch (e) {
        existing = [];
      }
    }

  const others = existing.filter((s) => s.uid !== uid);
    const existingMine = existing.filter((s) => s.uid === uid);
    const myIds = {};
    sessions.forEach((s) => { myIds[s.uid + '_' + s.id] = true; });
    const extraMine = existingMine.filter((s) => !myIds[s.uid + '_' + s.id]);
    const allMerged = others.concat(sessions).concat(extraMine);

  const seenKeys = {};
    const merged = allMerged.filter((s) => {
      const k = s.uid + '_' + s.id;
      if (seenKeys[k]) return false;
      seenKeys[k] = true;
      if (s.duration === 0 || s.duration > 57600) return false;
      return true;
    });

  const content = JSON.stringify(merged, null, 2);
                                 const encoded = btoa(unescape(encodeURIComponent(content)));

  const updateResp = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${file}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
            'User-Agent': 'RSAI-Tracker-App',
    },
    body: JSON.stringify({
      message: `Update sessions for uid ${uid} [skip ci]`,
      content: encoded,
      sha: currentSha,
      branch: 'classic-tracker',
    }),
  });


  if (updateResp.status === 409 || updateResp.status === 422) {
    if (attempt < MAX_RETRIES) {
      await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
      return doMergeAndWrite(attempt + 1);
    }
    return { error: 'Too many conflicting writes, please try again', status: 409 };
  }

  if (updateResp.status === 403 || updateResp.status === 429) {
    if (attempt < MAX_RETRIES) {
      const retryAfterHeader = updateResp.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : (400 * Math.pow(2, attempt) + Math.random() * 200);
      await sleep(retryAfterMs);
      return doMergeAndWrite(attempt + 1);
    }
    return { error: 'RATE_LIMITED', status: 429 };
  }

  if (!updateResp.ok) {
    const errText = await updateResp.text();
    if (attempt < MAX_RETRIES) {
      await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
      return doMergeAndWrite(attempt + 1);
    }
    return { error: 'GitHub update failed', details: errText, status: 500 };
  }

  return { ok: true, count: merged.length };
  }

  const result = await doMergeAndWrite();
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error, details: result.details }), {
      status: result.status || 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
} catch (err) {
  return new Response(JSON.stringify({ error: err.message }), {
    status: 500,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
