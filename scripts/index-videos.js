const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getVideoData(videoId) {
  const url = `https://tiktok-scraper7.p.rapidapi.com/?url=${videoId}`;
  try {
    const response = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': process.env.RAPID_API_KEY,
        'X-RapidAPI-Host': 'tiktok-scraper7.p.rapidapi.com'
      }
    });
    const data = await response.json();
    return {
      playUrl: data.data?.play || data.data?.wmplay || null,
      coverUrl: data.data?.cover || null,
      title: data.data?.title || ""
    };
  } catch (e) {
    return null;
  }
}

async function getOnScreenText(coverUrl) {
  if (!coverUrl) return null;
  try {
    console.log(`👁️ מנסה לקרוא טקסט מהמסך (Vision)...`);
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "מהו הטקסט השיווקי שכתוב על המסך בתמונה הזו? תענה רק בטקסט עצמו. אם אין טקסט, תענה 'ללא'." },
            { type: "image_url", image_url: { url: coverUrl } },
          ],
        },
      ],
    });
    const text = response.choices[0].message.content;
    return text === 'ללא' ? null : text;
  } catch (e) {
    console.error("❌ שגיאה בקריאת תמונה:", e.message);
    return null;
  }
}

async function indexVideos() {
  console.log("🚀 תחילת אינדוקס משולב (שמיעה + ראייה)...");

  const { data: videos, error } = await supabase.from('cached_videos').select('video_id').limit(3);
  if (error) return;

  for (const video of videos) {
    const id = video.video_id;
    console.log(`--- מעבד: ${id} ---`);

    const videoData = await getVideoData(id);
    if (!videoData?.playUrl) continue;

    // 1. ניסיון קריאת טקסט מהמסך
    const onScreenText = await getOnScreenText(videoData.coverUrl);
    
    // 2. תמלול אודיו (Whisper)
    let transcript = "";
    try {
      const audioRes = await fetch(videoData.playUrl);
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      const file = await OpenAI.toFile(buffer, 'video.mp4');
      const result = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "he",
        prompt: "סרטון שיווקי. אם יש רק מוזיקה, אל תתמלל כלום."
      });
      transcript = result.text;
    } catch (e) {
      console.log("⚠️ שגיאה בתמלול אודיו, נסתמך על טקסט מהמסך.");
    }

    // לוגיקה חכמה: אם התמלול נראה כמו ג'יבריש (קצר מדי או חוזר על עצמו), נשתמש בטקסט מהמסך
    const finalResult = (transcript.length < 10 || transcript.includes("תתת")) ? 
                        `[טקסט מהמסך]: ${onScreenText || ''}` : 
                        `${transcript}${onScreenText ? ` | [על המסך]: ${onScreenText}` : ''}`;

    await supabase.from('video_analysis').insert({
      aweme_id: id,
      transcript: finalResult,
      source_url: videoData.playUrl
    });
    
    console.log(`🎯 הצלחה עבור ${id}`);
  }
}

indexVideos();
