const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  console.log(`📡 פונה ל-RapidAPI עבור סרטון: ${videoId}`);
  const url = `https://tiktok-scraper7.p.rapidapi.com/video/info?video_id=${videoId}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    
    // הדפסה של כל מה שחזר מרפיד כדי שנוכל לראות את המבנה
    console.log(`📝 תשובה מלאה מרפיד:`, JSON.stringify(data).substring(0, 500)); 

    // ניסיון לחלץ את הלינק מכמה מקומות אפשריים
    const playUrl = data.data?.play || data.data?.play_url || data.play_url || data.play || null;
    
    if (!playUrl) {
        console.log(`⚠️ אזהרה: לא נמצא שדה URL מוכר. הודעת ה-API: ${data.msg || 'אין הודעה'}`);
    }
    return playUrl;
  } catch (e) {
    console.error(`❌ שגיאה טכנית בפנייה לרפיד:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת סבב אינדוקס...");

  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id')
    .limit(2); // רק 2 סרטונים לבדיקה מהירה

  if (error) {
    console.error("❌ שגיאה בסופאבייס:", error.message);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לעיבוד.`);

  for (const video of videos) {
    const id = video.video_id;
    console.log(`--- בודק: ${id} ---`);

    const freshUrl = await getFreshVideoUrl(id);
    if (!freshUrl) continue;

    try {
      console.log(`🎙️ מתמלל עכשיו...`);
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(freshUrl),
        model: "whisper-1",
        language: "he"
      });

      await supabase.from('video_analysis').insert({
        aweme_id: id,
        transcript: transcription.text,
        source_url: freshUrl
      });
      console.log(`🎯 הצלחה עבור סרטון ${id}!`);
    } catch (err) {
      console.error(`❌ שגיאה בתמלול:`, err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 הסתיים."));
