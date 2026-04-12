// scripts/index-videos.js — YUMi Full Indexer v2.2 (Clean Version)
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

###
