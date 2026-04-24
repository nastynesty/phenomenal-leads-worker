export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    try {
      // Parse form data (supports both JSON and form-urlencoded/multipart)
      const contentType = request.headers.get('content-type') || '';
      let data = {};
      if (contentType.includes('application/json')) {
        data = await request.json();
      } else {
        const formData = await request.formData();
        for (const [key, value] of formData.entries()) {
          data[key] = value;
        }
      }

      // Basic validation
      const name = (data.name || data.fullName || '').toString().trim();
      const email = (data.email || '').toString().trim();
      const phone = (data.phone || '').toString().trim();
      if (!name || !email) {
        return new Response(JSON.stringify({ error: 'Name and email required' }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      // Honeypot spam check
      if (data._gotcha || data.website) {
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
      }

      // Extract designImage before saving to KV (too large for KV values)
      const designImage = (data.designImage || '').toString().trim();
      const hasDesignImage = designImage.startsWith('data:image/');

      // Save to KV (lead log) — without the image data URL
      const leadId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const leadRecord = {
        id: leadId,
        timestamp,
        name, email, phone,
        source: data._source || data.source || 'website',
        address: data.address || null,
        project: data.project || null,
        template: data.template || null,
        size: data.size || null,
        zones_summary: data.zones_summary || null,
        total: data.total || null,
        breakdown: data.breakdown || null,
        pool_finish: data.pool_finish || null,
        concrete_finish: data.concrete_finish || null,
        timeline: data.timeline || null,
        contact_methods: data.contact_methods || null,
        contact_time: data.contact_time || null,
        has_design_image: hasDesignImage,
        userAgent: request.headers.get('user-agent'),
        ip: request.headers.get('cf-connecting-ip'),
        submitted_at: data.submitted_at || timestamp,
      };

      // Pass 26: Detect structures-only flow — no pool traced, no zones drawn,
      // but the user picked structures (kitchen/pergola/etc). Subject + banner
      // make this obvious so the team knows the pool wasn't measured.
      const zonesEmpty = !data.zones_summary || data.zones_summary === 'no zones drawn';
      const isRemodelOrResurface = data.project_slug === 'remodel' || data.project_slug === 'resurface' ||
        data.project === 'Pool Remodel + Resurface' || data.project === 'Pool Resurface';
      const structuresOnly = zonesEmpty && (data.total && Number(data.total) > 0);

      // Pass 26: Format the contact preferences in human-friendly form.
      // Common values: 'phone, text, email' / 'none' / 'phone'.
      function fmtContactMethods(raw) {
        if (!raw) return 'Not specified';
        const s = String(raw).toLowerCase();
        if (s === 'none' || s.includes('none')) return 'DO NOT CONTACT (customer opted out)';
        const parts = s.split(/[,\s]+/).filter(Boolean).map(p => {
          if (p === 'phone' || p === 'call') return 'Phone call';
          if (p === 'text' || p === 'sms') return 'Text';
          if (p === 'email') return 'Email';
          return p.charAt(0).toUpperCase() + p.slice(1);
        });
        return parts.join(', ') || 'Not specified';
      }
      function fmtContactTime(raw) {
        if (!raw || raw === 'none') return null;
        const m = { 'morning': 'Morning (8am-12pm)', 'afternoon': 'Afternoon (12pm-5pm)', 'evening': 'Evening (5pm-8pm)', 'anytime': 'Anytime' };
        return m[String(raw).toLowerCase()] || raw;
      }
      await env.LEADS.put(`lead:${timestamp}:${leadId}`, JSON.stringify(leadRecord));

      // Build plain-text fallback
      // Pass 26: Surfaced contact_methods + contact_time. Reordered so the
      // contact section sits right under the basic identity fields where the
      // team actually looks first.
      const displayFields = [
        ['Name', name],
        ['Email', email],
        ['Phone', phone],
        ['Address', data.address],
        ['Preferred Contact', fmtContactMethods(data.contact_methods)],
        ['Best Time to Reach', fmtContactTime(data.contact_time)],
        ['Project', data.project],
        ['Template', data.template],
        ['Size', data.size],
        ['Zones', data.zones_summary],
        ['Pool Finish', data.pool_finish],
        ['Concrete Finish', data.concrete_finish],
        ['Timeline', data.timeline],
        ['Total Estimate', data.total ? `$${Number(data.total).toLocaleString()}` : null],
        ['Breakdown', data.breakdown],
        ['Source', data.source],
        ['Received', timestamp],
        ['Lead ID', leadId],
      ].filter(([, v]) => v);

      const textLines = displayFields.map(([k, v]) => `${k}: ${v}`).join('\n');

      // Build HTML email
      const tableRows = displayFields
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-weight:600;white-space:nowrap;vertical-align:top;color:#374151;">${escHtml(k)}</td><td style="padding:4px 0;color:#111827;">${escHtml(String(v))}</td></tr>`)
        .join('');

      const totalDisplay = data.total
        ? `<div style="margin:20px 0;padding:16px 20px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:6px;"><span style="font-size:13px;color:#166534;font-weight:600;">ESTIMATED TOTAL</span><br><span style="font-size:28px;font-weight:700;color:#15803d;">$${Number(data.total).toLocaleString()}</span></div>`
        : '';

      // Pass 26: Warning banner for structures-only leads (pool not measured)
      const structuresOnlyBanner = structuresOnly
        ? `<div style="margin:20px 0;padding:14px 18px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:6px;"><div style="font-size:12px;color:#92400e;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:4px;">Structures Only · Pool Not Measured</div><div style="font-size:13px;color:#78350f;line-height:1.5;">Customer picked structures and finishes but did not trace their pool. The total above does not include resurface costs. Reach out to confirm pool dimensions before quoting.</div></div>`
        : '';

      // Pass 26: Highlight contact preferences card under the green total bar.
      // If customer opted out, show a red "DO NOT CONTACT" banner instead.
      const cmRaw = String(data.contact_methods || '').toLowerCase();
      const optedOut = cmRaw === 'none' || cmRaw.includes('none');
      const cmDisplay = fmtContactMethods(data.contact_methods);
      const ctDisplay = fmtContactTime(data.contact_time);
      const contactBanner = optedOut
        ? `<div style="margin:16px 0;padding:14px 18px;background:#fef2f2;border-left:4px solid #ef4444;border-radius:6px;"><div style="font-size:12px;color:#991b1b;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:4px;">Do Not Contact</div><div style="font-size:13px;color:#7f1d1d;">Customer explicitly opted out of contact.</div></div>`
        : (data.contact_methods
          ? `<div style="margin:16px 0;padding:14px 18px;background:#eff6ff;border-left:4px solid #3b82f6;border-radius:6px;"><div style="font-size:12px;color:#1e3a8a;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:6px;">How To Reach Them</div><div style="font-size:14px;color:#1e3a8a;font-weight:600;">${escHtml(cmDisplay)}</div>${ctDisplay ? `<div style="font-size:13px;color:#1e40af;margin-top:2px;">Best time: ${escHtml(ctDisplay)}</div>` : ''}</div>`
          : '');

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
    <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">Sent from Phenomenal Pool &amp; Landscape estimator &middot; Lead ID: ${leadId}</p>
  </div>
</div>
</body>
</html>`;

      // Send via Resend
      // Pass 26: Subject prefixes:
      //   [DO NOT CONTACT] — customer opted out of contact
      //   [STRUCTURES ONLY] — pool was not measured (no resurface cost in total)
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
        // Don't fail the request — we still saved to KV
      }

      return new Response(JSON.stringify({ ok: true, id: leadId }), { headers: corsHeaders });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
