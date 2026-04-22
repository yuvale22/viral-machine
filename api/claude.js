export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const authRes = await fetch('https://tkzmtunzmdlfiapwzkop.supabase.co/auth/v1/user', {
      headers: { 'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs', 'Authorization': authHeader },
    });
    if (!authRes.ok) return res.status(401).json({ error: 'Invalid token' });
  } catch(e) { return res.status(401).json({ error: 'Auth failed' }); }

  const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'Claude API key not configured' });
  const { prompt, max_tokens, pdf_base64, image_urls } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    let content;
    if (image_urls && image_urls.length > 0) {
      content = [];
      for (const url of image_urls) {
        try {
          const imgRes = await fetch(url);
          if (imgRes.ok) {
            const buffer = await imgRes.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: contentType, data: base64 }
            });
          }
        } catch(e) {}
      }
      content.push({ type: 'text', text: prompt });
    } else if (pdf_base64) {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
        { type: 'text', text: prompt }
      ];
    } else {
      content = prompt;
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 4000,
        messages: [{ role: 'user', content }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
