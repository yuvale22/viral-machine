const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFreshVideoUrl(videoId) {
  const url = `https://tiktok-scraper7.p.rapidapi.com/video/info?video_id=${videoId}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    return data.data?.play || data.data?.wmplay || null;
  } catch (e) {
    console.error(`❌ שגיאה בשליפת לינק עבור ${videoId}:`, e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 מתחיל אינדוקס חכם (לינקים טריים מרפיד)...");

  const { data: videos, error } = await supabase
    .from('cached_videos') 
    .select('video_id')
    .limit(5); 

  if (error) {
    console.error("❌ שגיאה בשליפת סרטונים:", error.message);
    return;
  }

  console.log(`🔎 נמצאו ${videos.length} סרטונים לעיבוד.`);

  for (const video of videos) {
    const id = video.video_id;

    const { data: existing } = await supabase
      .from('video_analysis')
      .select('aweme_id')
      .eq('aweme_id', id)
      .single();

    if (existing) {
      console.log(`⏭️ סרטון ${id} כבר תומלל, מדלג...`);
      continue;
    }

    const freshUrl = await getFreshVideoUrl(id);
    if (!freshUrl) {
      console.log(`⚠️ לא נמצא לינק עבור ${id}`);
      continue;
    }

    try {
      console.log(`🎙️ מתמלל סרטון ${id}...`);
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

      console.log(`✅ הצלחה! תמלול נשמר עבור ${id}`);
    } catch (err) {
      console.error(`❌ שגיאה בעיבוד ${id}:`, err.message);
    }
  }
}

indexVideos();
