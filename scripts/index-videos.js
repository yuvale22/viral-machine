// scripts/index-videos.js — YUMi Full Indexer v2
require('dotenv').config();
const SUPA_URL='https://tkzmtunzmdlfiapwzkop.supabase.co';
const SK=process.env.SUPABASE_SERVICE_ROLE_KEY, OK=process.env.OPENAI_API_KEY, RK=process.env.RAPIDAPI_KEY;
const BATCH=10, MAX=25*1024*1024;
if(!SK||!OK||!RK){console.error('Missing env: SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, RAPIDAPI_KEY');process.exit(1);}
const H={'apikey':SK,'Authorization':'Bearer '+SK,'Content-Type':'application/json'};

async function pick(){
  // KILL-LIST MODE: fetch ALL existing aweme_ids from video_analysis (any quality),
  // then pull top viral cached_videos that are NOT in that set.
  console.log('   📋 Building kill-list of already-analyzed videos...');
  const er=await fetch(`${SUPA_URL}/rest/v1/video_analysis?select=aweme_id&limit=50000`,{headers:H});
  const done=new Set((er.ok?await er.json():[]).map(r=>r.aweme_id));
  console.log(`   🎯 ${done.size} videos already analyzed (will be skipped)`);

  // Pull top-viral cached videos in pages until we collect BATCH unseen ones
  const fresh=[];
  let offset=0,page=200;
  while(fresh.length<BATCH&&offset<2000){
    const cr=await fetch(`${SUPA_URL}/rest/v1/cached_videos?select=*&order=play_count.desc&limit=${page}&offset=${offset}`,{headers:H});
    const rows=cr.ok?await cr.json():[];
    if(!rows.length)break;
    for(const v of rows){
      if(v.video_id&&!done.has(v.video_id)){
        fresh.push(v);
        if(fresh.length>=BATCH)break;
      }
    }
    offset+=page;
  }
  console.log(`   ✨ ${fresh.length} fresh viral videos selected\n`);
  return fresh;
}

async function getFresh(id){
  try{const r=await fetch(`https://tiktok-scraper7.p.rapidapi.com/?url=https://www.tiktok.com/@x/video/${id}&hd=1`,{headers:{'X-RapidAPI-Key':RK,'X-RapidAPI-Host':'tiktok-scraper7.p.rapidapi.com'}});
  if(!r.ok)return null;const j=await r.json();return j.data||null;}catch(e){return null;}
}

async function dl(url){
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.tiktok.com/'}});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const b=Buffer.from(await r.arrayBuffer());
  if(b.length>MAX)throw new Error('>25MB');
  return b;
}

async function whisper(buf,ext){
  const f=new FormData();
  f.append('file',new Blob([buf]),`v.${ext}`);
  f.append('model','whisper-1');f.append('response_format','verbose_json');
  const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{'Authorization':'Bearer '+OK},body:f});
  if(!r.ok)throw new Error('Whisper:'+(await r.text()).slice(0,100));
  return r.json();
}

async function analyze(text,v){
  const prompt=`אתה מומחה ויראליות בטיקטוק. תמלול מדויק של סרטון ויראלי + נתונים.

תמלול: """${text}"""
כותרת: ${v.title||v.he_title||''}
צפיות: ${v.play_count||0} | לייקים: ${v.digg_count||0} | משך: ${v.duration||0}s

כתוב בדיוק בפורמט הזה (חובה 3 חלקים עם ### כמו למטה, בלי ** או markdown נוסף):

### 1. איפיון שיווקי
[2-3 משפטים: Hook פסיכולוגי, למה זה עבד]

### 2. המלצות הפקה
- צילום: [המלצה]
- סאונד: [המלצה]
- עריכה: [המלצה]

### 3. תסריט ה-Vibe המקורי
[תסריט מלא בעברית 15-25 שניות, עם [הוראות צילום]. השתמש ב-{{BUSINESS_NAME}} ו-{{PRODUCT_NAME}} בתגיות אלו בלבד, אל תמציא שם עסק.]`;
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OK},body:JSON.stringify({model:'gpt-4o',max_tokens:1200,temperature:0.7,messages:[{role:'user',content:prompt}]})});
  if(!r.ok)throw new Error('GPT:'+(await r.text()).slice(0,100));
  const d=await r.json();
  return d.choices?.[0]?.message?.content||'';
}

async function save(row){
  const r=await fetch(SUPA_URL+'/rest/v1/video_analysis',{method:'POST',headers:{...H,'Prefer':'resolution=merge-duplicates'},body:JSON.stringify(row)});
  if(!r.ok)throw new Error('Save:'+(await r.text()).slice(0,100));
}

(async()=>{
  console.log('🚀 YUMi Indexer v2\n');
  const vids=await pick();
  if(!vids.length){console.log('✅ Nothing to process');return;}
  console.log(`\n🎬 Processing ${vids.length}:\n`);
  let ok=0,fail=0;
  for(let i=0;i<vids.length;i++){
    const v=vids[i],id=v.video_id;
    console.log(`\n[${i+1}/${vids.length}] ${id} — ${(v.title||v.he_title||'').slice(0,50)}`);
    try{
      process.stdout.write('   🔗 Fresh URL... ');
      const f=await getFresh(id);
      if(!f){console.log('SKIP');fail++;continue;}
      const useMusic=f.music_info?.original===true&&f.music;
      const url=useMusic?f.music:(f.play||f.hdplay);
      if(!url){console.log('SKIP no url');fail++;continue;}
      console.log('✓');
      process.stdout.write('   ⬇️  Download... ');
      const buf=await dl(url);console.log(`✓ ${Math.round(buf.length/1024)}KB`);
      process.stdout.write('   🎤 Whisper... ');
      const t=await whisper(buf,useMusic?'mp3':'mp4');
      const txt=(t.text||'').trim();
      if(txt.length<10){console.log('SKIP empty');fail++;continue;}
      console.log(`✓ ${txt.length}c ${t.language}`);
      process.stdout.write('   🧠 GPT-4o... ');
      const st=await analyze(txt,v);
      if(!st.includes('### 1.')||!st.includes('### 3.')){console.log('✗ bad format');fail++;continue;}
      console.log('✓');
      process.stdout.write('   💾 Save... ');
      await save({aweme_id:id,transcript:st,language:t.language||'unknown',duration_seconds:Math.round(t.duration||v.duration||0),audio_source:useMusic?'music_original':'video_extracted',source_url:url,analysis_quality:'full'});
      console.log('✓');ok++;
      await new Promise(r=>setTimeout(r,1000));
    }catch(e){console.log(`   ✗ ${e.message}`);fail++;}
  }
  console.log(`\n${'='.repeat(50)}\n✅ OK: ${ok}   ❌ Fail: ${fail}\n${'='.repeat(50)}`);
})();
