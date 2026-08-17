// functions/download-app.js
//
// Serves the RSAI Tracker desktop installers from R2.
//
//   /download-app?os=win                -> Windows NSIS installer
//   /download-app?os=mac&arch=arm64     -> macOS Apple Silicon .dmg
//   /download-app?os=mac&arch=x64       -> macOS Intel .dmg
//
// The filename for each build comes from desktop-version.json, so publishing a
// new release means uploading to R2 and editing that one file - no change here
// and no change to the Get App page.
//
// If R2_PUBLIC_URL is set the request is redirected there (cheapest path, and
// R2 handles range requests itself). Otherwise the object is streamed through
// this function with a SigV4-signed GET, which also works for a private bucket.
// Same env vars as upload-screenshot.js, plus optional R2_APPS_BUCKET /
// R2_APPS_PREFIX if installers live apart from screenshots.

const REGION = 'auto';
const SERVICE = 's3';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const os = (url.searchParams.get('os') || '').toLowerCase();
  const arch = (url.searchParams.get('arch') || '').toLowerCase();

  if (os !== 'win' && os !== 'mac') {
    return json({ error: 'Pass os=win or os=mac' }, 400);
  }

  // Resolve the build from the same manifest the Get App page reads.
  let manifest;
  try {
    const res = await fetch(new URL('/desktop-version.json', url.origin), { cf: { cacheTtl: 30 } });
    if (!res.ok) throw new Error('manifest ' + res.status);
    manifest = await res.json();
  } catch (err) {
    return json({ error: 'Could not read desktop-version.json', details: err.message }, 500);
  }

  const builds = manifest.builds || [];
  const build =
    builds.find((b) => b.os === os && (arch ? b.arch === arch : true)) ||
    builds.find((b) => b.os === os);

  if (!build || !build.file) {
    return json({ error: 'No published build for os=' + os + (arch ? ' arch=' + arch : '') }, 404);
  }

  const prefix = (env.R2_APPS_PREFIX === undefined ? 'desktop' : env.R2_APPS_PREFIX).replace(/^\/+|\/+$/g, '');
  const key = prefix ? prefix + '/' + build.file : build.file;

  // Preferred path: let the public R2 domain do the transfer.
  const publicBase = env.R2_APPS_PUBLIC_URL || env.R2_PUBLIC_URL;
  if (publicBase) {
    return Response.redirect(publicBase.replace(/\/+$/, '') + '/' + encodePath(key), 302);
  }

  // Fallback: stream it ourselves from a private bucket.
  const accountId = env.R2_ACCOUNT_ID;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_APPS_BUCKET || env.R2_BUCKET || 'rsai-screenshots';

  if (!accountId || !accessKey || !secretKey) {
    return json({
      error: 'R2 is not configured. Set R2_PUBLIC_URL, or R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.'
    }, 500);
  }

  const host = accountId + '.r2.cloudflarestorage.com';
  const canonicalUri = '/' + bucket + '/' + encodePath(key);
  const datetimeStr = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStr = datetimeStr.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalHeaders =
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + datetimeStr + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStr + '/' + REGION + '/' + SERVICE + '/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetimeStr,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join('\n');

  const signingKey = await getSigningKey(secretKey, dateStr, REGION, SERVICE);
  const signature = await hmacHex(signingKey, stringToSign);
  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const range = request.headers.get('Range');
  const upstreamHeaders = {
    Authorization: authorization,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': datetimeStr
  };
  if (range) upstreamHeaders.Range = range;   // let an interrupted download resume

  const upstream = await fetch('https://' + host + canonicalUri, { method: 'GET', headers: upstreamHeaders });

  if (!upstream.ok && upstream.status !== 206) {
    return json({ error: 'R2 download failed', status: upstream.status, key },
                upstream.status === 404 ? 404 : 502);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', 'attachment; filename="' + build.file + '"');
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('Accept-Ranges', 'bytes');
  for (const h of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  // Streamed, not buffered - these files are around 100 MB.
  return new Response(upstream.body, { status: upstream.status, headers });
}

function encodePath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 1), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// -- Crypto helpers (same as upload-screenshot.js) --------------------
async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, data) {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(key, data) {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const raw = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return new Uint8Array(raw);
}

async function getSigningKey(secretKey, dateStr, region, service) {
  const kDate = await hmacKey('AWS4' + secretKey, dateStr);
  const kRegion = await hmacKey(kDate, region);
  const kService = await hmacKey(kRegion, service);
  return await hmacKey(kService, 'aws4_request');
}
