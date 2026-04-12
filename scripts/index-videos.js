// scripts/index-videos.js — YUMi Full Indexer v2.2 (Complete Version)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Config & Env
const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OK = process.env.OPENAI_API_KEY;
const RK = process.env.RAPIDAPI_KEY || process.env.RAPID_API_KEY; 

const BATCH = 25; 
const MAX_SIZE = 25 * 1024 * 1024; 

if (!SK || !OK || !RK) {
    console.error('❌ Missing env vars: SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, or RAPIDAPI_KEY');
    process.exit(1);
}

const supabase = createClient(SUPA_URL, SK);

async function pick() {
    console.log('📋 Building kill-list of already-analyzed videos...');
    const { data: analyzed } = await supabase.from('video_analysis').select('video_id');
    const done = new Set((analyzed || []).map(r => r.video_id));
    console.log(`🎯 ${done.size} videos already analyzed (will be skipped)`);

    const fresh = [];
    let offset = 0, page = 200;
    while (fresh.length < BATCH && offset < 2000) {
        const { data: rows } = await supabase.from('cached_videos').select('*').order('play_count', { ascending: false }).range(offset, offset + page - 1);
        if (!rows || !rows.length) break;
        for (const v of rows) {
            if (v.video_id && !done.has(v.video_id)) {
                fresh.push(v);
                if (fresh.length >= BATCH) break;
            }
        }
        offset += page;
    }
    console.log(`✨ ${fresh.length} fresh viral videos selected\n`);
    return fresh;
}

async function getFreshMetadata(id) {
    try {
        const r = await fetch(`https://tiktok-scraper7.p.rapidapi.com/?url=https://www.tiktok.com/@x/video/${id}&hd=1`, {
            headers: { 'X-RapidAPI-Key': RK, 'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com' }
        });
        if (!r.ok) return null;
        const j = await r.json();
        return j.data || null;
    } catch (e) { return null; }
}

async function analyze(text, v) {
    const prompt = `אתה מומחה ויראליות בטיקטוק וקופירייטר עבור YUMi — פלטפורמה שעוזרת לבעלי עסקים קטנים בישראל ליצור תוכן ויראלי.

נתח את התמלול של הסרטון וייצר ניתוח מבני בפורמט של 4 החלקים הבאים (חובה להשתמש ב-### בדיוק):

תמלול: """${text}"""
כותרת: ${v.title || v.he_title || ''}
צפיות: ${v.play_count || 0}

### 1. איפיון שיווקי
(מה ה-Hook? איזה עיקרון ויראלי עבד כאן ולמה זה מעניין את הקהל הישראלי?)

### 2. המלצות הפקה
- צילום: [טיפ מעשי]
- סאונד: [מוזיקה/דיבור/אפקטים]
- עריכה: [קצב וחיתוכים]

### 3. תסריט ה-Vibe המקורי
(תסריט מלא לביצוע, השתמש ב-{{BUSINESS_NAME}} ו-{{PRODUCT_NAME}} בתגיות אלה בלבד).

### 4. שדרוג ויראלי של YUMi
(כאן תהיה המאמן של בעל העסק. איך להפוך את זה ליצירת מופת ויראלית ב-200%? הצע זוויות צילום מפתיעות, טקסטים דינמיים עם הוק חזק יותר, ופאנץ' סוף שגורם לשיתוף. דבר בטון מעשי: "תנסה ככה במקום...", "הוסף בשנייה ה-3...").`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OK}` },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 1800, temperature: 0.7, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
}

(async () => {
    console.log('🚀 YUMi Indexer v2.2\n');
    const vids = await pick();
    if (!vids.length) return;

    for (const v of vids) {
        const id = v.video_id;
        console.log(`\n🎬 Processing ID: ${id}`);
        try {
            const meta = await getFreshMetadata(id);
            if (!meta) throw new Error('Metadata failed');
            const audioUrl = meta.music_info?.play_url || meta.play || meta.hdplay;

            const res = await fetch(audioUrl);
            const buf = Buffer.from(await res.arrayBuffer());

            const formData = new FormData();
            formData.append('file', new Blob([buf]), 'audio.mp3');
            formData.append('model', 'whisper-1');

            const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${OK}` },
                body: formData
            });
            const tData = await whisperRes.json();
            const transcriptText = tData.text;

            console.log('🧠 Analyzing...');
            const analysis = await analyze(transcriptText, v);

            await supabase.from('video_analysis').upsert({
                video_id: id,
                transcript: transcriptText,
                analysis_text: analysis,
                analysis_quality: 'full',
                language: tData.language || 'iw',
                last_updated: new Date()
            });
            console.log('✅ Success!');
        } catch (e) {
            console.log(`❌ Failed: ${e.message}`);
        }
    }
})();
// סוף הקובץ - וודא שהשורה שמעל (סגירת סוגריים) מופיעה אצלך!
