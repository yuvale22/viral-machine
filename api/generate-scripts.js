// api/generate-scripts.js
// POST { aweme_ids: [...], business_name, product_name }
// Cache-first; up to 2 misses run Vision fallback synchronously.
// 3+ misses -> return cached only + queue the rest as background (best-effort).

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrem10dW56bWRsZmlhcHd6a29wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzcyMTcsImV4cCI6MjA4OTE1MzIxN30.td9gx19iEU4jl8ph6JX33LHm-K-vQtNG5TW9q_kHWRs';
const MAX_SYNC_MISSES = 2;
const VISION_TIMEOUT_MS = 7000;

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
  // Match "### 1. ... ### 2. ... ### 3. ..."
  const m = raw.match(/###\s*1\.\s*[^\n]*\n([\s\S]*?)###\s*2\.\s*[^\n]*\n([\s\S]*?)###\s*3\.\s*[^\n]*\n([\s\S]*)/);
  if (!m) return { marketing: '', production: '', script: raw.trim() };
  return {
    marketing: m[1].trim(),
    production: m[2].trim(),
    script: m[3].trim(),
  };
}

function applyReplacements(text, businessName, productName) {
  return (text || '')
    .replace(/\{\{BUSINESS_NAME\}\}/g, businessName || 'העסק שלך')
    .replace(/\{\{PRODUCT_NAME\}\}/g, productName || 'המוצר שלנו');
}

async function visionFallback(video) {
  // video: { aweme_id, cover_url, title }
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
          content: video.cover_url ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: video.cover_url } },
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
    const tooMany = misses.length > MAX_SYNC_MISSES;
    const toProcess = tooMany ? [] : misses;
    const deferred = tooMany ? misses : [];

    // 3. Fetch video metadata for misses we'll process
    if (toProcess.length > 0) {
      const missIds = toProcess.map(id => `"${id}"`).join(',');
      const metaRes = await fetch(
        `${SUPA_URL}/rest/v1/cached_videos?aweme_id=in.(${missIds})&select=aweme_id,cover_url,title`,
        { headers: adminH }
      );
      const metas = metaRes.ok ? await metaRes.json() : [];
      const metaMap = {};
      metas.forEach(m => { metaMap[m.aweme_id] = m; });

      // 4. Run vision fallback in parallel
      const results = await Promise.all(
        toProcess.map(id => visionFallback(metaMap[id] || { aweme_id: id }))
      );

      // 5. Save successful ones to cache
      const toInsert = [];
      results.forEach((transcript, i) => {
        if (transcript) {
          const id = toProcess[i];
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
      if (!entry?.transcript) return { aweme_id: id, status: 'pending' };
      const parsed = parseTranscript(entry.transcript);
      return {
        aweme_id: id,
        status: 'ready',
        quality: entry.analysis_quality || 'full',
        marketing: applyReplacements(parsed.marketing, business_name, product_name),
        production: applyReplacements(parsed.production, business_name, product_name),
        script: applyReplacements(parsed.script, business_name, product_name),
      };
    });

    return res.status(200).json({
      scripts,
      total: aweme_ids.length,
      ready: scripts.filter(s => s.status === 'ready').length,
      pending: deferred.length,
      message: deferred.length > 0
        ? `${deferred.length} סרטונים בעיבוד — רענן בעוד דקה`
        : null,
    });

  } catch (error) {
    console.error('generate-scripts error:', error);
    return res.status(500).json({ error: error.message });
  }
};
