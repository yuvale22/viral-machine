const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  console.log(`📡 פונה ל-RapidAPI עבור סרטון: ${videoId}`);
  
  // שיניתי כאן מ-video/info ל-post/info - זה ה-Endpoint הנכון ב-scraper7
  const url = `https://tiktok-scraper7.p.rapidapi.com/post/info?video_id=${videoId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    
    console.log(`📝 תשובה מרפיד:`, JSON.stringify(data).substring(0, 300)); 

    // שליפת ה-play url מהמבנה של scraper7
    const playUrl = data.data?.play || data.data?.wmplay || null;
    
    if (!playUrl) {
        console.log(`⚠️ לא נמצא URL. שגיאה מה-API: ${data.msg || 'אין פירוט'}`);
    }
    return playUrl;
  } catch (e) {
    console.error(`❌ שגיאה טכנית:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת סבב אינדוקס...");

  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id')
    .limit(2); 

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
      console.log(`🎙️ מתמלל עכשיו ב-OpenAI...`);
      const transcription = await openai.audio.transcriptions.create({
        file: await fetch(freshUrl),
        model: "whisper-1",
        language: "he"
      });

      const { error: insertError } = await supabase.from('video_analysis').insert({
        aweme_id: id,
        transcript: transcription.text,
        source_url: freshUrl
      });

      if (insertError) {
          console.error("❌ שגיאה בשמירה לסופאבייס:", insertError.message);
      } else {
          console.log(`🎯 הצלחה עבור סרטון ${id}!`);
      }
    } catch (err) {
      console.error(`❌ שגיאה בתמלול:`, err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 הסתיים."));
