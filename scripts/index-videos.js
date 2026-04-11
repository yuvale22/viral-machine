const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  console.log(`📡 פונה ל-RapidAPI (Root Endpoint) עבור: ${videoId}`);
  
  // ב-Scraper 7 ה-Endpoint הוא שורש ה-API והפרמטר הוא url
  const url = `https://tiktok-scraper7.p.rapidapi.com/?url=${videoId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    
    // זה הלוג הקריטי - אם זה מצליח, נראה כאן את כל פרטי הסרטון
    console.log(`📝 תשובה מרפיד:`, JSON.stringify(data).substring(0, 500)); 

    // שליפת הלינק מהמבנה של TikWM (נמצא בתוך data.play)
    const playUrl = data.data?.play || data.data?.wmplay || null;
    
    if (!playUrl) {
        console.log(`⚠️ לא נמצא לינק ב-JSON. הודעה: ${data.msg || 'אין'}`);
    }
    return playUrl;
  } catch (e) {
    console.error(`❌ שגיאה טכנית:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת סבב אינדוקס סופי...");

  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id')
    .limit(3); 

  if (error) {
    console.error("❌ שגיאה בסופאבייס:", error.message);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לעיבוד.`);

  for (const video of videos) {
    const id = video.video_id;
    console.log(`--- מעבד סרטון: ${id} ---`);

    const freshUrl = await getFreshVideoUrl(id);
    if (!freshUrl) continue;

    try {
      console.log(`🎙️ שולח ל-Whisper...`);
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(freshUrl),
        model: "whisper-1",
        language: "he"
      });

      console.log(`✅ תמלול מוכן! שומר לסופאבייס...`);
      await supabase.from('video_analysis').insert({
        aweme_id: id,
        transcript: transcription.text,
        source_url: freshUrl
      });
      
      console.log(`🎯 הצלחה מלאה עבור ${id}!`);
    } catch (err) {
      console.error(`❌ שגיאה בתמלול ${id}:`, err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 הסתיים."));
