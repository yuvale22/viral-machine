// scripts/index-videos.js — YUMi Full Indexer v2 (unlimited)
require('dotenv').config();
const SUPA_URL='https://tkzmtunzmdlfiapwzkop.supabase.co';
const SK=process.env.SUPABASE_SERVICE_ROLE_KEY, OK=process.env.OPENAI_API_KEY;
const BATCH=20, MAX=25*1024*1024;
if(!SK||!OK){console.error('Missing env: SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY');process.exit(1);}
const H={'apikey':SK,'Authorization':'Bearer '+SK,'Content-Type':'application/json'};

async function pick(){
  console.log('   📋 Building kill-list of already-analyzed videos...');
  const er=await fetch(`${SUPA_URL}/rest/v1/video_analysis?select=aweme_id&limit=50000`,{headers:H});
  const done=new Set((er.ok?await er.json():[]).map(r=>r.aweme_id));
  console.log(`   🎯 ${done.size} videos already analyzed (will be skipped)`);

  const cutoff=new Date(Date.now()-48*60*60*1000).toISOString();
  console.log(`   ⏰ Only considering videos added after ${cutoff.slice(0,16)}`);

  const fresh=[];
  let offset=0,page=200;
  while(fresh.length<BATCH&&offset<2000){
    const q=`select=*&audio_url=not.is.null&created_at=gte.${cutoff}&order=play_count.desc&limit=${page}&offset=${offset}`;
    const cr=await fetch(`${SUPA_URL}/rest/v1/cached_videos?${q}`,{headers:H});
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
  console.log(`   ✨ ${fresh.length} fresh videos selected (≤48h old, has audio_url)\n`);
  return fresh;
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
  const prompt=`אתה מומחה ויראליות בטיקטוק וקופירייטר עבור YUMi — פלטפורמה שעוזרת לבעלי עסקים קטנים בישראל ליצור תוכן ויראלי.

לפניך תמלול של סרטון אמיתי מבעל עסק ישראלי, בצירוף נתוני ביצועים:

תמלול: """${text}"""
כותרת: ${v.title||v.he_title||''}
צפיות: ${v.play_count||0} | לייקים: ${v.digg_count||0} | משך: ${v.duration||0}s

המשימה שלך: לייצר ניתוח מבני שיעזור לבעל עסק אחר ללמוד מהסרטון הזה ולשדרג אותו. כתוב בדיוק בפורמט של 4 החלקים הבאים (חובה לשמור על ה-### בדיוק כפי שמופיע, בלי ** או * או כל markdown אחר):

### 1. איפיון שיווקי
[2-3 משפטים: מה ה-Hook הפסיכולוגי שמשך את הצופים? איזה עיקרון ויראלי זיהית — פער סקרנות, הפתעה, זיהוי, רגש, פתרון בעיה? למה זה עבד דווקא לקהל הזה?]

### 2. המלצות הפקה
- צילום: [המלצה מעשית מבוססת על מה שזוהה בסרטון]
- סאונד: [המלצה — מוזיקה, דיבור, אפקטים]
- עריכה: [המלצה — קצב, חיתוכים, מעברים]

### 3. תסריט ה-Vibe המקורי
[תסריט מלא בעברית, 15-25 שניות, עם [הוראות צילום בסוגריים מרובעים]. השתמש ב-{{BUSINESS_NAME}} ו-{{PRODUCT_NAME}} בתגיות אלה בלבד — אל תמציא שמות עסק או מוצר ספציפיים. שמור על אותו מבנה, קצב ועוצמה של הסרטון המקורי.]

### 4. שדרוג ויראלי של YUMi
[הסעיף הכי חשוב — כאן אתה לוקח את הרעיון השיווקי של הסרטון המקורי ומציע איך להפוך אותו ליצירת מופת ויראלית. תן 3-5 המלצות קונקרטיות ומעשיות שמשדרגות את רמת ההפקה: זוויות צילום מפתיעות, אפקטים ויזואליים, טקסטים על המסך עם הוק חזק יותר, פתיח שעוצר את הגלילה ב-2 שניות, פאנץ' סוף שגורם לשיתוף, מוזיקה טרנדית מתאימה. כתוב בטון של מאמן יוצר תוכן — "תנסה ככה במקום…" / "הוסף בשנייה ה-3…" / "במקום X תעשה Y". המטרה: שבעל עסק עם טלפון וסבלנות יוכל לקחת את ההמלצות האלה ולבצע אותן מחר בבוקר.]`;
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OK},body:JSON.stringify({model:'gpt-4o',max_tokens:1800,temperature:0.7,messages:[{role:'user',content:prompt}]})});
  if(!r.ok)throw new Error('GPT:'+(await r.text()).slice(0,100));
  const d=await r.json();
  return d.choices?.[0]?.message?.content||'';
}

async function save(row){
  const r=await fetch(SUPA_URL+'/rest/v1/video_analysis',{method:'POST',headers:{...H,'Prefer':'resolution=merge-duplicates'},body:JSON.stringify(row)});
  if(!r.ok)throw new Error('Save:'+(await r.text()).slice(0,100));
}

(async()=>{
  console.log('🚀 YUMi Indexer v2 (unlimited)\n');
  const vids=await pick();
  if(!vids.length){console.log('✅ Nothing to process');return;}
  console.log(`\n🎬 Processing ${vids.length}:\n`);
  let ok=0,fail=0;
  for(let i=0;i<vids.length;i++){
    const v=vids[i],id=v.video_id;
    console.log(`\n[${i+1}/${vids.length}] ${id} — ${(v.title||v.he_title||'').slice(0,50)}`);
    try{
      const url=v.audio_url;
      if(!url){console.log('   SKIP no audio_url in row');fail++;continue;}
      const useMusic=(v.audio_source==='music_original');
      process.stdout.write('   ⬇️  Download... ');
      const buf=await dl(url);console.log(`✓ ${Math.round(buf.length/1024)}KB`);
      process.stdout.write('   🎤 Whisper... ');
      const t=await whisper(buf,useMusic?'mp3':'mp4');
      const txt=(t.text||'').trim();
      if(txt.length<10){console.log('SKIP empty');fail++;continue;}
      console.log(`✓ ${txt.length}c ${t.language}`);
      process.stdout.write('   🧠 GPT-4o... ');
      const st=await analyze(txt,v);
      if(!st.includes('### 1.')||!st.includes('### 3.')||!st.includes('### 4.')){console.log('✗ bad format');fail++;continue;}
      console.log('✓');
      process.stdout.write('   💾 Save... ');
      await save({aweme_id:id,transcript:st,language:t.language||'unknown',duration_seconds:Math.round(t.duration||v.duration||0),audio_source:useMusic?'music_original':'video_extracted',source_url:url,analysis_quality:'full'});
      console.log('✓');ok++;
      await new Promise(r=>setTimeout(r,2500));
    }catch(e){console.log(`   ✗ ${e.message}`);fail++;}
  }
  console.log(`\n${'='.repeat(50)}\n✅ OK: ${ok}   ❌ Fail: ${fail}\n${'='.repeat(50)}`);
})();
