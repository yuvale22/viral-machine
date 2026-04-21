// api/generate-scripts.js
// POST { aweme_ids: [...], business_name, product_name }
// Cache-first; misses run Claude fallback SEQUENTIALLY.
// Client now sends 1 video per call, so we give full time budget to each.

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';

async function getUserFromToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': authHeader },
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function parseTranscript(raw) {
  if (!raw) return null;
  const m4 = raw.match(/###\s*1\.\s*[^\n]*\n([\s\S]*?)###\s*2\.\s*[^\n]*\n([\s\S]*?)###\s*3\.\s*[^\n]*\n([\s\S]*?)###\s*4\.\s*[^\n]*\n([\s\S]*)/);
  if (m4) return { marketing: m4[1].trim(), production: m4[2].trim(), script: m4[3].trim(), viral_upgrade: m4[4].trim() };
  const m3 = raw.match(/###\s*1\.\s*[^\n]*\n([\s\S]*?)###\s*2\.\s*[^\n]*\n([\s\S]*?)###\s*3\.\s*[^\n]*\n([\s\S]*)/);
  if (m3) return { marketing: m3[1].trim(), production: m3[2].trim(), script: m3[3].trim(), viral_upgrade: '' };
  return { marketing: '', production: '', script: raw.trim(), viral_upgrade: '' };
}

function applyReplacements(text, businessName, productName) {
  return (text || '')
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName || 'העסק שלך')
    .replace(/\{\{PRODUCT_NAME\}\}/g, productName || 'המוצר שלנו');
}

async function claudeFallback(video, timeoutMs) {
  const videoTitle = video.he_title || video.title || 'ללא כותרת';
  const videoDesc = video.description || '';

  const prompt = `אתה מומחה לתסריטי טיקטוק ויראליים. בהתבסס על כותרת הסרטון והתיאור, כתוב ניתוח שיווקי קצר, המלצות הפקה, ותסריט מוכן לצילום.
החזר בדיוק בפורמט הזה:

### 1. איפיון שיווקי
[2-3 משפטים על ה-Hook הפסיכולוגי]

### 2. המלצות הפקה
- צילום: [המלצה]
- סאונד: [המלצה]
- עריכה: [המלצה]

### 3. תסריט ה-Vibe המקורי
[תסריט קצר בעברית עם הוראות צילום בסוגריים. השתמש ב-{{BUSINESS_NAME}} ו-{{PRODUCT_NAME}}.]

כותרת: ${videoTitle}
${videoDesc ? 'תיאור: ' + videoDesc.slice(0, 200) : ''}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { clearTimeout(timeout); return null; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error('Claude API error:', r.status, errBody.slice(0, 200));
      return null;
    }
    const data = await r.json();
    return data.content?.[0]?.text || '';
  } catch (e) {
    clearTimeout(timeout);
    console.error('Claude fallback failed:', e.message);
    return null;
  }
}

module.exports.config = { maxDuration: 10 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const startTime = Date.now();

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Missing service key' });

  const { aweme_ids, business_name, product_name } = req.body || {};
  if (!Array.isArray(aweme_ids) || aweme_ids.length === 0) {
    return res.status(400).json({ error: 'aweme_ids required' });
  }

  const adminH = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Fetch existing analyses
    const idsParam = aweme_ids.map(id => `"${id}"`).join(',');
    const cacheRes = await fetch(
      `${SUPA_URL}/rest/v1/video_analysis?aweme_id=in.(${idsParam})&select=aweme_id,transcript,analysis_quality`,
      { headers: adminH }
    );
    const cached = cacheRes.ok ? await cacheRes.json() : [];
    const cacheMap = {};
    cached.forEach(c => { cacheMap[c.aweme_id] = c; });

    // 2. Identify misses
    const misses = aweme_ids.filter(id => !cacheMap[id]);

    // 3. Fetch metadata for misses
    let metaMap = {};
    if (misses.length > 0) {
      const missIds = misses.map(id => `"${id}"`).join(',');
      const metaRes = await fetch(
        `${SUPA_URL}/rest/v1/cached_videos?video_id=in.(${missIds})&select=video_id,title,he_title,description`,
        { headers: adminH }
      );
      const metas = metaRes.ok ? await metaRes.json() : [];
      metas.forEach(m => { metaMap[m.video_id] = m; });
    }

    // 4. Run Claude fallback — give full remaining time (client sends 1 video per call)
    const toInsert = [];

    for (const id of misses) {
      const elapsed = Date.now() - startTime;
      const remaining = 9500 - elapsed; // 9.5s total budget (Vercel limit is 10s)

      if (remaining < 2000) {
        console.log(`Time budget exhausted (${elapsed}ms elapsed)`);
        break;
      }

      const transcript = await claudeFallback(
        metaMap[id] || { video_id: id },
        remaining - 500 // give Claude all remaining time minus small buffer
      );

      if (transcript) {
        cacheMap[id] = { aweme_id: id, transcript, analysis_quality: 'lite' };
        toInsert.push({ aweme_id: id, transcript, analysis_quality: 'lite' });
      }
    }

    // 5. Save to cache (fire and forget)
    if (toInsert.length > 0) {
      fetch(SUPA_URL + '/rest/v1/video_analysis', {
        method: 'POST',
        headers: { ...adminH, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(toInsert),
      }).catch(e => console.error('Save error:', e));
    }

    // 6. Build response
    const scripts = aweme_ids.map(id => {
      const entry = cacheMap[id];
      if (!entry?.transcript) {
        return { aweme_id: id, status: 'failed', error: 'לא ניתן ליצור תסריט לסרטון זה' };
      }
      const parsed = parseTranscript(entry.transcript);
      return {
        aweme_id: id,
        status: 'ready',
        quality: entry.analysis_quality || 'full',
        marketing: applyReplacements(parsed.marketing, business_name, product_name),
        production: applyReplacements(parsed.production, business_name, product_name),
        script: applyReplacements(parsed.script, business_name, product_name),
        viral_upgrade: applyReplacements(parsed.viral_upgrade, business_name, product_name),
      };
    });

    const readyCount = scripts.filter(s => s.status === 'ready').length;
    const failedCount = scripts.filter(s => s.status === 'failed').length;

    return res.status(200).json({
      scripts,
      total: aweme_ids.length,
      ready: readyCount,
      failed: failedCount,
    });

  } catch (error) {
    console.error('generate-scripts error:', error);
    return res.status(500).json({ error: error.message });
  }
};
