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

      // Save to KV (lead log)
      const leadId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const leadRecord = {
        id: leadId,
        timestamp,
        name, email, phone,
        source: data._source || data.source || 'website',
        ...data,
        userAgent: request.headers.get('user-agent'),
        ip: request.headers.get('cf-connecting-ip'),
      };
      await env.LEADS.put(`lead:${timestamp}:${leadId}`, JSON.stringify(leadRecord));

      // Format email body (simple, plain)
      const subject = `New Pool Lead — ${name}`;
      const lines = [
        `Name: ${name}`,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        '',
        'Details:',
        ...Object.entries(data)
          .filter(([k]) => !['name', 'email', 'phone', '_gotcha', 'website'].includes(k))
          .map(([k, v]) => `  ${k}: ${v}`),
        '',
        `Received: ${timestamp}`,
        `Lead ID: ${leadId}`,
      ].filter(Boolean).join('\n');

      // Send via Resend
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `Phenomenal Leads <${env.FROM_EMAIL}>`,
          to: [env.NOTIFY_EMAIL],
          reply_to: email,
          subject,
          text: lines,
        }),
      });

      if (!resendRes.ok) {
        const err = await resendRes.text();
        console.error('Resend error:', err);
        // Don't fail the request — we still saved to KV
      }

      return new Response(JSON.stringify({ ok: true, id: leadId }), { headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
