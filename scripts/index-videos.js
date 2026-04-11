const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  console.log(`📡 פונה ל-RapidAPI עבור: ${videoId}`);
  const url = `https://tiktok-scraper7.p.rapidapi.com/?url=${videoId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    const playUrl = data.data?.play || data.data?.wmplay || null;
    return playUrl;
  } catch (e) {
    console.error(`❌ שגיאה ב-RapidAPI:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת סבב אינדוקס ממוקד דיבור...");

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
    console.log(`--- מעבד: ${id} ---`);

    // בדיקה אם הסרטון כבר קיים בתמלולים (כדי לא לשלם פעמיים)
    const { data: existing } = await supabase
      .from('video_analysis')
      .select('aweme_id')
      .eq('aweme_id', id)
      .maybeSingle();

    if (existing) {
      console.log(`⏭️ סרטון ${id} כבר תומלל, מדלג.`);
      continue;
    }

    const freshUrl = await getFreshVideoUrl(id);
    if (!freshUrl) continue;

    try {
      console.log(`🎙️ שולח ל-Whisper עם הנחיית פוקוס...`);
      
      const response = await fetch(freshUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const file = await OpenAI.toFile(buffer, 'video.mp4');

      const transcription = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "he",
        // הפרומפט הקריטי שמתעלם מהמוזיקה:
        prompt: "זהו סרטון שיווקי בעברית. נא לתמלל רק את הדיבור של האדם בסרטון בצורה מדויקת, ולהתעלם ממוזיקת רקע, שירים או רעשים של סביבה."
      });

      console.log(`✅ תמלול התקבל! שומר לסופאבייס...`);
      await supabase.from('video_analysis').insert({
        aweme_id: id,
        transcript: transcription.text,
        source_url: freshUrl
      });
      
      console.log(`🎯 הצלחה עבור ${id}!`);
    } catch (err) {
      console.error(`❌ שגיאה בתמלול ${id}:`, err.message);
    }
  }
}

indexVideos().then(() => console.log("🏁 הסתיים."));
