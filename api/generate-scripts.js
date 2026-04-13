// api/generate-scripts.js
// POST { aweme_ids: [...], business_name, product_name }
// Cache-first; ALL misses run Vision fallback in parallel (bounded by Vercel 10s max).

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const VISION_TIMEOUT_MS = 8000;

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
  // Try to match 4 sections (new format with viral upgrade)
  const m4 = raw.match(/###\s*1\.\s*[^\n]*\n([\s\S]*?)###\s*2\.\s*[^\n]*\n([\s\S]*?)###\s*3\.\s*[^\n]*\n([\s\S]*?)###\s*4\.\s*[^\n]*\n([\s\S]*)/);
  if (m4) {
    return {
      marketing: m4[1].trim(),
      production: m4[2].trim(),
      script: m4[3].trim(),
      viral_upgrade: m4[4].trim(),
    };
  }
  // Fallback to 3 sections (old format)
  const m3 = raw.match(/###\s*1\.\s*[^\n]*\n([\s\S]*?)###\s*2\.\s*[^\n]*\n([\s\S]*?)###\s*3\.\s*[^\n]*\n([\s\S]*)/);
  if (m3) {
    return {
      marketing: m3[1].trim(),
      production: m3[2].trim(),
      script: m3[3].trim(),
      viral_upgrade: '',
    };
  }
  return { marketing: '', production: '', script: raw.trim(), viral_upgrade: '' };
}

function applyReplacements(text, businessName, productName) {
  return (text || '')
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName || 'העסק שלך')
    .replace(/\{\{PRODUCT_NAME\}\}/g, productName || 'המוצר שלנו');
}

async function visionFallback(video) {
  // video: { video_id, cover, title }
  const prompt = `אתה מומחה לתסריטי טיקטוק ויראליים. בהתבסס על תמונת הקאבר והכותרת, כתוב ניתוח שיווקי, המלצות הפקה, ותסריט מוכן לצילום.
החזר בדיוק בפורמט הזה (חשוב — שמור על ה-### וההפרדות):

### 1. איפיון שיווקי
[ניתוח קצר של ה-Hook הפסיכולוגי, 2-3 משפטים]

### 2. המלצות הפקה
- צילום: [המלצה]
- סאונד: [המלצה]
- עריכה: [המלצה]

### 3. תסריט ה-Vibe המקורי
[תסריט מוכן לצילום בעברית, עם הוראות צילום בסוגריים מרובעים. השתמש בתגיות {{BUSINESS_NAME}} ו-{{PRODUCT_NAME}} בתוך התסריט במקומות הרלוונטיים.]

כותרת הסרטון: ${video.title || 'ללא כותרת'}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: video.cover ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: video.cover } },
          ] : prompt,
        }],
      }),
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error('Vision API ' + r.status);
    const data = await r.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    clearTimeout(timeout);
    console.error('Vision fallback failed:', e.message);
    return null;
  }
}

module.exports.config = { maxDuration: 10 };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    // 1. Fetch existing analyses from video_analysis
    const idsParam = aweme_ids.map(id => `"${id}"`).join(',');
    const cacheRes = await fetch(
      `${SUPA_URL}/rest/v1/video_analysis?aweme_id=in.(${idsParam})&select=aweme_id,transcript,analysis_quality`,
      { headers: adminH }
    );
    const cached = cacheRes.ok ? await cacheRes.json() : [];
    const cacheMap = {};
    cached.forEach(c => { cacheMap[c.aweme_id] = c; });

    // 2. Identify misses — ALL of them, no cap
    const misses = aweme_ids.filter(id => !cacheMap[id]);

    // 3. Fetch video metadata for misses — NOTE: column is video_id, not aweme_id
    if (misses.length > 0) {
      const missIds = misses.map(id => `"${id}"`).join(',');
      const metaRes = await fetch(
        `${SUPA_URL}/rest/v1/cached_videos?video_id=in.(${missIds})&select=video_id,cover,title`,
        { headers: adminH }
      );
      const metas = metaRes.ok ? await metaRes.json() : [];
      const metaMap = {};
      metas.forEach(m => { metaMap[m.video_id] = m; });

      // 4. Run vision fallback on ALL misses in parallel (single Promise.all = ~5-8s total)
      const results = await Promise.all(
        misses.map(id => visionFallback(metaMap[id] || { video_id: id }))
      );

      // 5. Save successful ones to cache
      const toInsert = [];
      results.forEach((transcript, i) => {
        if (transcript) {
          const id = misses[i];
          cacheMap[id] = { aweme_id: id, transcript, analysis_quality: 'lite' };
          toInsert.push({ aweme_id: id, transcript, analysis_quality: 'lite' });
        }
      });
      if (toInsert.length > 0) {
        fetch(SUPA_URL + '/rest/v1/video_analysis', {
          method: 'POST',
          headers: { ...adminH, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(toInsert),
        }).catch(e => console.error('Save error:', e));
      }
    }

    // 6. Build response — parse + replace placeholders
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
      message: failedCount > 0
        ? `${readyCount} תסריטים נוצרו (${failedCount} סרטונים לא הצליחו — נסה סרטונים אחרים)`
        : null,
    });

  } catch (error) {
    console.error('generate-scripts error:', error);
    return res.status(500).json({ error: error.message });
  }
};
