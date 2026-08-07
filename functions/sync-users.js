// Cloudflare Pages Function: /functions/sync-users.js
// Syncs the users list to GitHub's users.json using a server-side PAT secret.
// Called by the RSAI Tracker app when a user is added/removed/updated.
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
        const { users, _clientPat } = body;
        const pat = env.GITHUB_PAT || _clientPat || '';
        if (!pat) {
                return new Response(JSON.stringify({ error: 'GITHUB_PAT not configured' }), {
                          status: 500,
                          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
        }
        if (!users || !Array.isArray(users)) {
                return new Response(JSON.stringify({ error: 'Invalid users data' }), {
                          status: 400,
                          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                });
        }

      const owner = 'RevenueStream-AI';
        const repo = 'rsai-tracker';
        const file = 'users.json';
        const apiBase = 'https://api.github.com';

      // Build users list - strip passwords and sensitive data
      const usersToSave = users
.filter((u) => true)
          .map((u) => ({
                    id: u.id,
                    name: u.name,
                    email: u.email,
                    role: u.role,
                    dept: u.dept,
                    shift: u.shift,
                    jobTitle: u.jobTitle || '',
                    phone: u.phone || '',
                    status: u.status,
                    startDate: u.startDate,
                    invited: u.invited || false,
                    manager: u.manager || null,
                    leaveBalance: u.leaveBalance || { vacation: 6, sick: 4, personal: 2 },
                    needsSetup: u.needsSetup !== false,
                    color: u.color || 1,
                    pin: u.pin || '0000',
                    pwh: u.pwh || '',
          }));

      const content = JSON.stringify(
        {
                  users: usersToSave,
                  updated: new Date().toISOString(),
                  note: 'RSAI Tracker user database. Managed automatically by the app.',
        },
              null,
              2
            );
        // Encode to base64
      const encoded = btoa(unescape(encodeURIComponent(content)));

      async function doWrite(attempt = 0) {
              // Get current file SHA (re-fetched on every attempt so retries use a fresh SHA)
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
                                return doWrite(attempt + 1);
                    }
                    return { error: 'Failed to fetch current file', status: 500 };
          }

          const fileData = await fileResp.json();
              const currentSha = fileData.sha;

          // Update file on GitHub
          const updateResp = await fetch(`${apiBase}/repos/${owner}/${repo}/contents/${file}`, {
                    method: 'PUT',
                    headers: {
                                Authorization: `token ${pat}`,
                                Accept: 'application/vnd.github.v3+json',
                                'Content-Type': 'application/json',
                                'User-Agent': 'RSAI-Tracker-App',
                    },
                    body: JSON.stringify({
                                message: `Update users.json (${usersToSave.length} users)`,
                                content: encoded,
                                sha: currentSha,
                                branch: 'classic-tracker',
                    }),
          });

          if (updateResp.status === 409 || updateResp.status === 422) {
                    if (attempt < MAX_RETRIES) {
                                await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
                                return doWrite(attempt + 1);
                    }
                    return { error: 'Too many conflicting writes, please try again', status: 409 };
          }

          if (updateResp.status === 403 || updateResp.status === 429) {
                    if (attempt < MAX_RETRIES) {
                                const retryAfterHeader = updateResp.headers.get('Retry-After');
                                const retryAfterMs = retryAfterHeader
                                  ? parseInt(retryAfterHeader, 10) * 1000
                                              : 400 * Math.pow(2, attempt) + Math.random() * 200;
                                await sleep(retryAfterMs);
                                return doWrite(attempt + 1);
                    }
                    return { error: 'RATE_LIMITED', status: 429 };
          }

          if (!updateResp.ok) {
                    const errText = await updateResp.text();
                    if (attempt < MAX_RETRIES) {
                                await sleep(250 * Math.pow(2, attempt) + Math.random() * 150);
                                return doWrite(attempt + 1);
                    }
                    return { error: 'GitHub update failed', details: errText, status: 500 };
          }

          return { ok: true, count: usersToSave.length };
      }

      const result = await doWrite();
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
