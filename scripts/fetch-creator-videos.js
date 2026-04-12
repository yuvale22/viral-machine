// scripts/fetch-creator-videos.js — YUMi Cache Fetcher v1
// Pulls latest N videos from every curated creator and writes them to cached_videos.
// ZERO filtering — viral, mid, niche, all welcome. The indexer will analyze them later.
//
// Run locally: node scripts/fetch-creator-videos.js
// Run in CI:   GitHub Action with env secrets
//
// Required env:
//   SUPABASE_SERVICE_ROLE_KEY
//   RAPIDAPI_KEY

require('dotenv').config();

const SUPA_URL = 'https://tkzmtunzmdlfiapwzkop.supabase.co';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RK = process.env.RAPIDAPI_KEY;
const PER_CREATOR = 30;          // how many recent videos to pull per creator
const SLEEP_BETWEEN_CALLS = 1500; // ms — be polite to RapidAPI

if (!SK || !RK) {
  console.error('❌ Missing env vars. Need: SUPABASE_SERVICE_ROLE_KEY, RAPIDAPI_KEY');
  process.exit(1);
}

const H = {
  'apikey': SK,
  'Authorization': 'Bearer ' + SK,
  'Content-Type': 'application/json',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ========== STEP 1: Load all curated creators ==========
async function loadCreators() {
  const r = await fetch(`${SUPA_URL}/rest/v1/creators?select=username,industry_id,notes&order=created_at.asc`, { headers: H });
  if (!r.ok) throw new Error('Failed to load creators: ' + r.status);
  return r.json();
}

// ========== STEP 2: Build a kill-list of video_ids already in cached_videos ==========
async function loadExistingVideoIds() {
  console.log('   📋 Loading existing cached_videos IDs...');
  const r = await fetch(`${SUPA_URL}/rest/v1/cached_videos?select=video_id&limit=50000`, { headers: H });
  if (!r.ok) return new Set();
  const rows = await r.json();
  const set = new Set(rows.map(row => row.video_id));
  console.log(`   🎯 ${set.size} videos already in cache (will be skipped)\n`);
  return set;
}

// ========== STEP 3: Fetch latest posts for one creator from RapidAPI ==========
async function fetchPosts(username) {
  const clean = username.replace('@', '').trim();
  const url = `https://tiktok-scraper7.p.rapidapi.com/user/posts?unique_id=${encodeURIComponent(clean)}&count=${PER_CREATOR}&cursor=0`;
  const r = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': RK,
      'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com',
    },
  });
  if (!r.ok) throw new Error('RapidAPI ' + r.status);
  const json = await r.json();
  const videos = json.data?.videos || json.data || json.videos || [];
  return Array.isArray(videos) ? videos : [];
}

// ========== STEP 4: Insert one video into cached_videos ==========
async function saveVideo(v, creator) {
  const row = {
    video_id: v.video_id || v.id || v.aweme_id || '',
    account_username: creator.username.replace('@', ''),
    industry_id: creator.industry_id,
    title: v.title || v.desc || '',
    description: v.desc || v.title || '',
    play_count: v.play_count || v.stats?.playCount || 0,
    digg_count: v.digg_count || v.stats?.diggCount || 0,
    duration: v.duration || v.video?.duration || 0,
    author_uid: v.author?.unique_id || creator.username.replace('@', ''),
    engagement: v.play_count > 0 ? Math.round((v.digg_count || 0) / v.play_count * 1000) / 10 : 0,
    he_title: '',
    he_subtitle: '',
  };
  if (!row.video_id) return false;

  const r = await fetch(`${SUPA_URL}/rest/v1/cached_videos`, {
    method: 'POST',
    headers: { ...H, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  return r.ok;
}

// ========== MAIN ==========
(async () => {
  console.log('🚀 YUMi Cache Fetcher\n');

  const creators = await loadCreators();
  console.log(`📦 Found ${creators.length} curated creators\n`);

  if (creators.length === 0) {
    console.log('⚠️  No creators in DB. Add some via the admin dashboard first.');
    return;
  }

  const existing = await loadExistingVideoIds();

  let totalFetched = 0;
  let totalNew = 0;
  let totalSkipped = 0;
  let creatorsOk = 0;
  let creatorsFailed = 0;

  for (let i = 0; i < creators.length; i++) {
    const c = creators[i];
    const tag = `[${i + 1}/${creators.length}] @${c.username.replace('@', '')}`;
    process.stdout.write(`${tag} — ${c.industry_id}... `);

    try {
      const videos = await fetchPosts(c.username);
      totalFetched += videos.length;

      let newCount = 0;
      let skipCount = 0;
      for (const v of videos) {
        const id = v.video_id || v.id || v.aweme_id || '';
        if (!id) continue;
        if (existing.has(id)) { skipCount++; continue; }
        const ok = await saveVideo(v, c);
        if (ok) { newCount++; existing.add(id); }
      }

      totalNew += newCount;
      totalSkipped += skipCount;
      creatorsOk++;
      console.log(`✓ ${videos.length} fetched, ${newCount} new, ${skipCount} dup`);
    } catch (e) {
      creatorsFailed++;
      console.log(`✗ ${e.message}`);
    }

    if (i < creators.length - 1) await sleep(SLEEP_BETWEEN_CALLS);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`👥 Creators:  ${creatorsOk} ok, ${creatorsFailed} failed`);
  console.log(`🎬 Videos:    ${totalFetched} fetched`);
  console.log(`✨ New:       ${totalNew} added to cache`);
  console.log(`⏭️  Duplicate: ${totalSkipped} skipped`);
  console.log(`${'='.repeat(50)}`);

  // Exit non-zero if literally nothing succeeded — useful for CI alerts
  if (creatorsOk === 0) process.exit(1);
})();
