// scripts/fetch-creator-videos.js — YUMi Cache Fetcher v1.1 (Resilient Version)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Config & Env
const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
// תיקון: בודק את שני סוגי השמות למפתח כדי למנוע את השגיאה שראינו בגיטהאב
const RK = process.env.RAPIDAPI_KEY || process.env.RAPID_API_KEY; 

const PER_CREATOR = 30;         // כמה סרטונים למשוך מכל יוצר
const SLEEP_MS = 1500;          // הפסקה קטנה בין קריאות ל-API

if (!SK || !RK) {
  console.error('❌ Missing env vars. Need: SUPABASE_SERVICE_ROLE_KEY, RAPID_API_KEY');
  process.exit(1);
}

// Initialize Supabase Client
const supabase = createClient(SUPA_URL, SK);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runFetcher() {
  console.log('🚀 YUMi Cache Fetcher — Building the Warehouse\n');

  // 1. Load curated creators from DB
  console.log('📦 Loading creators...');
  const { data: creators, error: cErr } = await supabase
    .from('creators')
    .select('username, industry_id')
    .order('created_at', { ascending: true });

  if (cErr || !creators) {
    console.error('❌ Failed to load creators:', cErr?.message);
    return;
  }
  console.log(`✅ Found ${creators.length} creators.\n`);

  // 2. Load existing IDs to avoid re-fetching
  const { data: existingRows } = await supabase
    .from('cached_videos')
    .select('video_id');
  const existingSet = new Set((existingRows || []).map(r => r.video_id));
  console.log(`🎯 ${existingSet.size} videos already in cache. Skipping them.\n`);

  let totalNew = 0;

  for (let i = 0; i < creators.length; i++) {
    const creator = creators[i];
    const username = creator.username.replace('@', '').trim();
    console.log(`[${i + 1}/${creators.length}] 📡 Fetching @${username}...`);

    try {
      const response = await fetch(`https://tiktok-scraper7.p.rapidapi.com/user/posts?unique_id=${encodeURIComponent(username)}&count=${PER_CREATOR}`, {
        headers: { 'X-RapidAPI-Key': RK, 'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com' }
      });
      
      const json = await response.json();
      const videos = json.data?.videos || json.data || [];

      if (!Array.isArray(videos)) {
        console.log(`   ⚠️  No videos found for @${username}`);
        continue;
      }

      let newInCreator = 0;
      for (const v of videos) {
        const id = v.video_id || v.id || v.aweme_id;
        if (!id || existingSet.has(id)) continue;

        // Map video data to our DB structure
        const { error: saveErr } = await supabase
          .from('cached_videos')
          .upsert({
            video_id: id,
            account_username: username,
            industry_id: creator.industry_id,
            title: v.title || v.desc || '',
            play_count: v.play_count || v.stats?.playCount || 0,
            digg_count: v.digg_count || v.stats?.diggCount || 0,
            duration: v.duration || v.video?.duration || 0,
            engagement: v.play_count > 0 ? Math.round((v.digg_count / v.play_count) * 1000) / 10 : 0,
          });

        if (!saveErr) {
          newInCreator++;
          totalNew++;
          existingSet.add(id);
        }
      }

      console.log(`   ✅ Added ${newInCreator} new videos.`);

    } catch (e) {
      console.log(`   ❌ Error: ${e.message}`);
    }

    if (i < creators.length - 1) await sleep(SLEEP_MS);
  }

  console.log(`\n${'='.repeat(30)}`);
  console.log(`✨ FINISHED! Added ${totalNew} new videos to cache.`);
  console.log(`${'='.repeat(30)}`);
}

runFetcher();
