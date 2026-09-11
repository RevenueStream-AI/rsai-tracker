// Cloudflare Pages Function: /functions/invite-user.js
// Creates a real Clerk invitation for a given email using Clerk's Backend API,
// and sends Clerk's own default (notify:true) built-in invitation email.
// (EmailJS custom-branded email is optional/unused unless EMAILJS_* env vars are set.)
// goes out. Also invites the person to the shared Clerk Organization so they
// land inside it automatically instead of hitting the "create your own org"
// screen. All secret keys stay server-side only and are never sent to the browser.
// Called by the RSAI Tracker admin Users page (sendInvite()).
//
// Orphaned-account recovery: an invitation link becomes unusable if it gets
// superseded (e.g. a second invite is sent before the first is accepted).
// If the person never finished sign-up, Clerk can still be left holding a
// user record for that email, and a fresh invite then fails with an
// "already exists" error even though nobody can actually sign in. When that
// happens below, we look up the existing Clerk user and, ONLY if they have
// never signed in (last_sign_in_at is empty -- i.e. the account is genuinely
// orphaned, not a real active user), delete it and retry the invitation
// automatically. A real account that has signed in before is left alone and
// still surfaces the original "they already have an account" error, since
// re-inviting an active user is never the right fix.

const ORG_ID = '';

function createInvitation(secretKey, email, name) {
    return fetch('https://api.clerk.com/v1/invitations', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + secretKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            email_address: email,
            redirect_url: 'https://tracker.revenuestream.ai/',
            notify: true,
            ignore_existing: true,
            public_metadata: name ? { name: name } : undefined,
        }),
    });
}

export async function onRequestPost(context) {
    const { request, env } = context;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim();

    if (!email) {
        return new Response(JSON.stringify({ error: 'Email is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const secretKey = env.CLERK_SECRET_KEY;
    if (!secretKey) {
        return new Response(JSON.stringify({ error: 'CLERK_SECRET_KEY not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    try {
        const listResp = await fetch('https://api.clerk.com/v1/invitations?status=pending&limit=100', {
            headers: { Authorization: 'Bearer ' + secretKey },
        });
        if (listResp.ok) {
            const listData = await listResp.json();
            const items = Array.isArray(listData) ? listData : (listData.data || []);
            const stale = items.filter((inv) => (inv.email_address || '').toLowerCase() === email);
            for (const inv of stale) {
                await fetch('https://api.clerk.com/v1/invitations/' + inv.id + '/revoke', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' },
                });
            }
        }
    } catch (e) {
    }

    let resp = await createInvitation(secretKey, email, name);
    let data = await resp.json();
    let recoveredOrphan = false;

    if (!resp.ok) {
        const firstMsg = (data.errors && data.errors[0] && data.errors[0].message) || '';
        const looksLikeExistingAccount = /already exist|already a member|duplicate/i.test(firstMsg);

        if (looksLikeExistingAccount) {
            try {
                const lookupResp = await fetch(
                    'https://api.clerk.com/v1/users?email_address=' + encodeURIComponent(email),
                    { headers: { Authorization: 'Bearer ' + secretKey } }
                );
                if (lookupResp.ok) {
                    const lookupData = await lookupResp.json();
                    const users = Array.isArray(lookupData) ? lookupData : (lookupData.data || []);
                    const existing = users[0];

                    // Only recover an orphaned account: created by a superseded
                    // invite link but never actually used to sign in. A real,
                    // active account is left untouched.
                    if (existing && !existing.last_sign_in_at) {
                        const delResp = await fetch('https://api.clerk.com/v1/users/' + existing.id, {
                            method: 'DELETE',
                            headers: { Authorization: 'Bearer ' + secretKey },
                        });
                        if (delResp.ok) {
                            resp = await createInvitation(secretKey, email, name);
                            data = await resp.json();
                            recoveredOrphan = true;
                        }
                    }
                }
            } catch (e) {
                // fall through -- original error response below still applies
            }
        }
    }

    if (!resp.ok) {
        const msg = (data.errors && data.errors[0] && data.errors[0].message) || 'Clerk invitation failed';
        return new Response(JSON.stringify({ error: msg, details: data }), {
            status: resp.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const inviteLink = data.url
            || (data.ticket ? ('https://accounts.revenuestream.ai/sign-up?__clerk_ticket=' + data.ticket) : 'https://tracker.revenuestream.ai/');

    let orgInvite = null; if (ORG_ID)
    try {
        try {
            const orgListResp = await fetch(
                'https://api.clerk.com/v1/organizations/' + ORG_ID + '/invitations?status=pending&limit=100',
                { headers: { Authorization: 'Bearer ' + secretKey } }
                );
            if (orgListResp.ok) {
                const orgListData = await orgListResp.json();
                const orgItems = Array.isArray(orgListData) ? orgListData : (orgListData.data || []);
                const staleOrg = orgItems.filter((inv) => (inv.email_address || '').toLowerCase() === email);
                for (const inv of staleOrg) {
                    await fetch(
                        'https://api.clerk.com/v1/organizations/' + ORG_ID + '/invitations/' + inv.id + '/revoke',
                        { method: 'POST', headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' } }
                        );
                }
            }
        } catch (e) {
        }

    const orgResp = await fetch('https://api.clerk.com/v1/organizations/' + ORG_ID + '/invitations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_address: email, role: 'org:member', notify: false }),
    });
        const orgData = await orgResp.json();
        if (orgResp.ok) {
            orgInvite = 'invited';
        } else {
            const orgMsg = (orgData.errors && orgData.errors[0] && orgData.errors[0].message) || 'org invite failed';
            orgInvite = /already/i.test(orgMsg) ? 'already_member' : ('failed: ' + orgMsg);
        }
    } catch (e) {
        orgInvite = 'failed: ' + e.message;
    }

    let emailSent = false;
    let emailError = null;
    const ejsServiceId = env.EMAILJS_SERVICE_ID;
    const ejsTemplateId = env.EMAILJS_TEMPLATE_ID;
    const ejsPublicKey = env.EMAILJS_PUBLIC_KEY;
    const ejsPrivateKey = env.EMAILJS_PRIVATE_KEY;

    if (ejsServiceId && ejsTemplateId && ejsPublicKey && ejsPrivateKey) {
        try {
            const ejsResp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service_id: ejsServiceId,
                    template_id: ejsTemplateId,
                    user_id: ejsPublicKey,
                    accessToken: ejsPrivateKey,
                    template_params: {
                        to_email: email,
                        to_name: name || email,
                        invite_link: inviteLink,
                    },
                }),
            });
            emailSent = ejsResp.ok;
            if (!ejsResp.ok) emailError = await ejsResp.text();
        } catch (e) {
            emailError = e.message;
        }
    } else {
        emailError = 'EmailJS environment variables not configured';
    }

    return new Response(JSON.stringify({
        ok: true,
        invitation: { id: data.id, status: data.status, email_address: data.email_address },
        recoveredOrphan,
        orgInvite,
        emailSent,
        emailError,
    }), {
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
