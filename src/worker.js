// Pass 29 D — added admin endpoints (/admin/leads, /admin/leads/:id/mark,
// /admin/leads/export.csv) protected by a shared bearer token (ADMIN_TOKEN
// wrangler secret). The lead intake POST behavior is unchanged.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight — covers both the public /lead POST and the admin GETs.
    if (method === 'OPTIONS') {
      return corsPreflight();
    }

    // Admin routes (auth-protected).
    if (path.startsWith('/admin/leads')) {
      const auth = checkAdminAuth(request, env);
      if (auth !== true) return auth; // 401 Response

      // GET /admin/leads — list with optional ?q=&limit=&cursor=
      if (path === '/admin/leads' && method === 'GET') {
        return await handleListLeads(request, env);
      }

      // GET /admin/leads/export.csv — full CSV export
      if (path === '/admin/leads/export.csv' && method === 'GET') {
        return await handleExportCsv(env);
      }

      // POST /admin/leads/:id/mark — toggle/set contacted status
      const markMatch = path.match(/^\/admin\/leads\/([^/]+)\/mark$/);
      if (markMatch && method === 'POST') {
        return await handleMarkContacted(markMatch[1], request, env);
      }

      // GET /admin/leads/:id — single lead detail
      const detailMatch = path.match(/^\/admin\/leads\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        return await handleLeadDetail(detailMatch[1], env);
      }

      return jsonResp({ error: 'Not found' }, 404);
    }

    // Public lead intake — accepts POST to / or /lead.
    if (method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    return await handleLeadIntake(request, env, ctx);
  },
};

// --- helpers ---------------------------------------------------------------

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  }, extra || {});
}

function corsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: corsHeaders(),
  });
}

// Constant-time-ish string compare to avoid timing leaks on the bearer.
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Check Authorization: Bearer <ADMIN_TOKEN>. Returns `true` if OK,
// otherwise a 401 Response ready to be returned.
function checkAdminAuth(request, env) {
  if (!env.ADMIN_TOKEN) {
    return jsonResp({ error: 'Server misconfigured: ADMIN_TOKEN not set' }, 500);
  }
  const hdr = request.headers.get('authorization') || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m || !safeEq(m[1].trim(), env.ADMIN_TOKEN.trim())) {
    return jsonResp({ error: 'Unauthorized' }, 401);
  }
  return true;
}

// --- admin: list leads -----------------------------------------------------

async function handleListLeads(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
  const cursor = url.searchParams.get('cursor') || undefined;

  // KV list returns metadata-light keys. We page through and read values
  // for the slice the user wants. Free tier KV is rate-limited so we cap
  // the read fan-out at `limit`.
  const listed = await env.LEADS.list({ prefix: 'lead:', limit, cursor });

  const reads = await Promise.all(
    listed.keys.map(async (k) => {
      const raw = await env.LEADS.get(k.name);
      if (!raw) return null;
      try {
        const rec = JSON.parse(raw);
        rec._key = k.name;
        return rec;
      } catch (_) {
        return null;
      }
    })
  );

  let leads = reads.filter(Boolean);

  // Newest first — keys embed ISO timestamp so reverse-sort by key works.
  leads.sort((a, b) => (b._key || '').localeCompare(a._key || ''));

  // Optional case-insensitive search across name/email/phone/address/project/notes.
  if (q) {
    leads = leads.filter((l) => {
      const hay = [
        l.name, l.email, l.phone, l.address, l.project, l.notes, l.template, l.source,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  return jsonResp({
    ok: true,
    count: leads.length,
    cursor: listed.list_complete ? null : listed.cursor,
    leads,
  });
}

// --- admin: lead detail ----------------------------------------------------

async function handleLeadDetail(id, env) {
  // The KV key embeds the timestamp, so we list by suffix match.
  const listed = await env.LEADS.list({ prefix: 'lead:', limit: 1000 });
  const match = listed.keys.find((k) => k.name.endsWith(':' + id));
  if (!match) return jsonResp({ error: 'Not found' }, 404);
  const raw = await env.LEADS.get(match.name);
  if (!raw) return jsonResp({ error: 'Not found' }, 404);
  try {
    const rec = JSON.parse(raw);
    rec._key = match.name;
    return jsonResp({ ok: true, lead: rec });
  } catch (_) {
    return jsonResp({ error: 'Corrupt record' }, 500);
  }
}

// --- admin: mark contacted -------------------------------------------------

async function handleMarkContacted(id, request, env) {
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const contacted = body && body.contacted !== false; // default true
  const note = (body && typeof body.note === 'string') ? body.note : null;

  const listed = await env.LEADS.list({ prefix: 'lead:', limit: 1000 });
  const match = listed.keys.find((k) => k.name.endsWith(':' + id));
  if (!match) return jsonResp({ error: 'Not found' }, 404);

  const raw = await env.LEADS.get(match.name);
  if (!raw) return jsonResp({ error: 'Not found' }, 404);

  let rec;
  try { rec = JSON.parse(raw); } catch (_) { return jsonResp({ error: 'Corrupt record' }, 500); }

  rec.contacted = !!contacted;
  rec.contacted_at = contacted ? new Date().toISOString() : null;
  if (note !== null) rec.contact_note = note;

  await env.LEADS.put(match.name, JSON.stringify(rec));
  return jsonResp({ ok: true, lead: rec });
}

// --- admin: CSV export -----------------------------------------------------

const CSV_COLUMNS = [
  'id', 'timestamp', 'name', 'email', 'phone', 'address',
  'project', 'project_slug', 'template', 'size', 'total',
  'pool_finish', 'concrete_finish', 'timeline',
  'contact_methods', 'contact_time',
  'source', 'page', 'notes',
  // Pass 31: acquisition / attribution tracking
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'referrer', 'landing_page',
  'contacted', 'contacted_at', 'contact_note',
];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function handleExportCsv(env) {
  // Pull every lead. Free-tier KV list cap is 1000/page, so we paginate.
  const all = [];
  let cursor;
  do {
    const page = await env.LEADS.list({ prefix: 'lead:', limit: 1000, cursor });
    for (const k of page.keys) {
      const raw = await env.LEADS.get(k.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        all.push(rec);
      } catch (_) {}
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  all.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));

  const header = CSV_COLUMNS.join(',');
  const rows = all.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c])).join(','));
  const csv = [header, ...rows].join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="phenomenal-leads.csv"',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// --- public: lead intake (unchanged behavior, refactored into a function) --

async function handleLeadIntake(request, env, ctx) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let data = {};
    if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      const formData = await request.formData();
      for (const [key, value] of formData.entries()) {
        // FormData allows duplicate keys for checkboxes (e.g. contact_methods).
        // getAll preserves them; here we collapse repeats by appending into an array.
        if (data[key] === undefined) {
          data[key] = value;
        } else if (Array.isArray(data[key])) {
          data[key].push(value);
        } else {
          data[key] = [data[key], value];
        }
      }
    }

    // Basic validation
    const name = (data.name || data.fullName || '').toString().trim();
    const email = (data.email || '').toString().trim();
    const phone = (data.phone || '').toString().trim();
    if (!name || !email) {
      return jsonResp({ error: 'Name and email required' }, 400);
    }

    // Honeypot spam check
    if (data._gotcha || data.website) {
      return jsonResp({ ok: true });
    }

    // Normalize contact_methods — accept arrays, comma strings, or single value.
    let cmRaw = data.contact_methods;
    if (Array.isArray(cmRaw)) cmRaw = cmRaw.join(', ');

    const designImage = (data.designImage || '').toString().trim();
    const hasDesignImage = designImage.startsWith('data:image/');

    // Pass 31: project field — landing forms post `project_type`, design
    // studio posts `project`. Accept either; prefer the more specific one.
    const projectField = data.project || data.project_type || null;

    // Pass 31: acquisition attribution fields. Forms now inject these as
    // hidden inputs (lead-attribution.js). All optional, all string-safe.
    const utm_source   = (data.utm_source   || '').toString().trim() || null;
    const utm_medium   = (data.utm_medium   || '').toString().trim() || null;
    const utm_campaign = (data.utm_campaign || '').toString().trim() || null;
    const utm_term     = (data.utm_term     || '').toString().trim() || null;
    const utm_content  = (data.utm_content  || '').toString().trim() || null;
    const gclid        = (data.gclid        || '').toString().trim() || null;
    const fbclid       = (data.fbclid       || '').toString().trim() || null;
    const referrer     = (data.referrer     || '').toString().trim() || null;
    const landing_page = (data.landing_page || '').toString().trim() || null;

    const leadId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const leadRecord = {
      id: leadId,
      timestamp,
      name, email, phone,
      source: data._source || data.source || 'website',
      page: data.page || null,
      address: data.address || null,
      project: projectField,
      project_slug: data.project_slug || null,
      template: data.template || null,
      size: data.size || null,
      zones_summary: data.zones_summary || null,
      total: data.total || null,
      breakdown: data.breakdown || null,
      pool_finish: data.pool_finish || null,
      concrete_finish: data.concrete_finish || null,
      timeline: data.timeline || null,
      contact_methods: cmRaw || null,
      contact_time: data.contact_time || null,
      notes: data.notes || data.description || data.message || null,
      has_design_image: hasDesignImage,
      // Pass 31: acquisition attribution
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      gclid, fbclid, referrer, landing_page,
      userAgent: request.headers.get('user-agent'),
      ip: request.headers.get('cf-connecting-ip'),
      submitted_at: data.submitted_at || timestamp,
      // Pass 29 D admin tracking fields
      contacted: false,
      contacted_at: null,
      contact_note: null,
    };

    const zonesEmpty = !data.zones_summary || data.zones_summary === 'no zones drawn';
    const structuresOnly = zonesEmpty && (data.total && Number(data.total) > 0);

    function fmtContactMethods(raw) {
      if (!raw) return 'Not specified';
      const s = String(raw).toLowerCase();
      if (s === 'none' || s.includes('none')) return 'DO NOT CONTACT (customer opted out)';
      const parts = s.split(/[,\s]+/).filter(Boolean).map((p) => {
        if (p === 'phone' || p === 'call') return 'Phone call';
        if (p === 'text' || p === 'sms') return 'Text';
        if (p === 'email') return 'Email';
        return p.charAt(0).toUpperCase() + p.slice(1);
      });
      return parts.join(', ') || 'Not specified';
    }
    function fmtContactTime(raw) {
      if (!raw || raw === 'none') return null;
      const m = { morning: 'Morning (8am-12pm)', afternoon: 'Afternoon (12pm-5pm)', evening: 'Evening (5pm-8pm)', anytime: 'Anytime' };
      return m[String(raw).toLowerCase()] || raw;
    }

    await env.LEADS.put(`lead:${timestamp}:${leadId}`, JSON.stringify(leadRecord));

    const displayFields = [
      ['Name', name],
      ['Email', email],
      ['Phone', phone],
      ['Address', data.address],
      ['Preferred Contact', fmtContactMethods(cmRaw)],
      ['Best Time to Reach', fmtContactTime(data.contact_time)],
      ['Project', projectField],
      ['Template', data.template],
      ['Size', data.size],
      ['Zones', data.zones_summary],
      ['Pool Finish', data.pool_finish],
      ['Concrete Finish', data.concrete_finish],
      ['Timeline', data.timeline],
      ['Total Estimate', data.total ? `$${Number(data.total).toLocaleString()}` : null],
      ['Breakdown', data.breakdown],
      ['Notes', leadRecord.notes],
      ['Source', data.source],
      ['Page', data.page],
      // Pass 31: acquisition attribution surfaced in the email so you can
      // see at a glance whether the lead came from Google Ads, organic, etc.
      ['UTM Source', utm_source],
      ['UTM Medium', utm_medium],
      ['UTM Campaign', utm_campaign],
      ['UTM Term', utm_term],
      ['UTM Content', utm_content],
      ['Google Click ID', gclid],
      ['Facebook Click ID', fbclid],
      ['Referrer', referrer],
      ['Landing Page', landing_page],
      ['Received', timestamp],
      ['Lead ID', leadId],
    ].filter(([, v]) => v);

    const textLines = displayFields.map(([k, v]) => `${k}: ${v}`).join('\n');

    const tableRows = displayFields
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-weight:600;white-space:nowrap;vertical-align:top;color:#374151;">${escHtml(k)}</td><td style="padding:4px 0;color:#111827;">${escHtml(String(v))}</td></tr>`)
      .join('');

    const totalDisplay = data.total
      ? `<div style="margin:20px 0;padding:16px 20px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;"><span style="font-size:13px;color:#166534;font-weight:600;">ESTIMATED TOTAL</span><br><span style="font-size:28px;font-weight:700;color:#15803d;">$${Number(data.total).toLocaleString()}</span></div>`
      : '';

    const structuresOnlyBanner = structuresOnly
      ? `<div style="margin:20px 0;padding:14px 18px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;"><div style="font-size:12px;color:#92400e;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:4px;">Structures Only · Pool Not Measured</div><div style="font-size:13px;color:#78350f;line-height:1.5;">Customer picked structures and finishes but did not trace their pool. The total above does not include resurface costs. Reach out to confirm pool dimensions before quoting.</div></div>`
      : '';

    const cmLower = String(cmRaw || '').toLowerCase();
    const optedOut = !cmRaw || cmLower === 'none' || cmLower.includes('none') || cmLower.trim() === '';
    const cmDisplay = fmtContactMethods(cmRaw);
    const ctDisplay = fmtContactTime(data.contact_time);
    const contactBanner = optedOut
      ? `<div style="margin:16px 0;padding:14px 18px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:6px;"><div style="font-size:12px;color:#991b1b;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:4px;">Do Not Contact</div><div style="font-size:13px;color:#7f1d1d;">Customer left all contact methods unchecked. Treat as opt-out.</div></div>`
      : `<div style="margin:16px 0;padding:14px 18px;background:#eff6ff;border-left:4px solid #3b82f6;border-radius:6px;"><div style="font-size:12px;color:#1e3a8a;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">How To Reach Them</div><div style="font-size:14px;color:#1e3a8a;font-weight:600;">${escHtml(cmDisplay)}</div>${ctDisplay ? `<div style="font-size:13px;color:#1e40af;margin-top:2px;">Best time: ${escHtml(ctDisplay)}</div>` : ''}</div>`;

    const imageBlock = hasDesignImage
      ? `<div style="margin:20px 0;"><p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">DESIGN SCREENSHOT</p><img src="${designImage}" alt="Customer design" style="max-width:100%;border-radius:8px;border:1px solid #e5e7eb;" /></div>`
      : '';

    const htmlEmail = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f9fafb;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
  <div style="background:#0d47a1;padding:24px 28px;">
    <div style="color:#fff;font-size:20px;font-weight:700;">New Pool Lead</div>
    <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:2px;">${escHtml(name)} &middot; ${escHtml(email)}${phone ? ` &middot; ${escHtml(phone)}` : ''}</div>
  </div>
  <div style="padding:24px 28px;">
    ${totalDisplay}
    ${structuresOnlyBanner}
    ${contactBanner}
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      ${tableRows}
    </table>
    ${imageBlock}
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;line-height:1.5;">
      Sent from Phenomenal Pool &amp; Landscape leads worker &middot; Lead ID: ${leadId}<br>
      Phenomenal Pool &amp; Landscape, 5875 Pacific St Suite C-3, Rocklin, CA 95677 &middot;
      <a href="mailto:contact@916pools.com?subject=Unsubscribe%20${encodeURIComponent(email)}" style="color:#9ca3af;">unsubscribe</a>
    </p>
  </div>
</div>
</body>
</html>`;

    const subjectPrefix = optedOut ? '[DO NOT CONTACT] '
      : structuresOnly ? '[STRUCTURES ONLY] '
      : '';

    const resendPayload = {
      from: `Phenomenal Leads <${env.FROM_EMAIL}>`,
      to: [env.NOTIFY_EMAIL],
      reply_to: email,
      subject: `${subjectPrefix}New Pool Lead — ${name}${data.address ? ' · ' + data.address : ''}${data.total ? ' · $' + Number(data.total).toLocaleString() : ''}`,
      text: textLines,
      html: htmlEmail,
    };

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendPayload),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      console.error('Resend error:', err);
      // Don't fail the request — the lead is still in KV.
    }

    // Pass 32: fan out to the Phenomenal Pool Tracker app so this lead lands
    // directly in the Jobs pipeline (status=Lead) and admins get a push
    // notification. Fire-and-forget — if the app is down the lead is still in
    // KV + email, so we never break the customer's submit.
    try {
      const appUrl = env.APP_LEADS_URL || 'https://app.phenomenalpoolscapes.com/api/leads/inbound';
      const appPayload = {
        name,
        email,
        phone,
        address: data.address || null,
        message: data.notes || data.description || data.message || null,
        projectType: projectField || data.template || null,
        source: leadRecord.source || 'website',
      };
      // Use ctx.waitUntil so the worker keeps the fetch alive after we return
      // the response. Without this the runtime may cancel the in-flight fetch.
      const fanOut = fetch(appUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appPayload),
      }).then(async (r) => {
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          console.error('[app fan-out] non-ok status=' + r.status + ' body=' + t.slice(0, 200));
        }
      }).catch((e) => console.error('[app fan-out] failed:', e && e.message));
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(fanOut);
      } else {
        // Fallback when no ctx is available — await so we don't drop the request.
        await fanOut;
      }
    } catch (e) {
      console.error('[app fan-out] threw:', e && e.message);
    }

    return jsonResp({ ok: true, id: leadId });
  } catch (err) {
    console.error('Worker error:', err);
    return jsonResp({ error: err.message }, 500);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
