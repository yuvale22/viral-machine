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
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "מהו הטקסט השיווקי שכתוב על המסך בתמונה הזו? תענה רק בטקסט עצמו. אם אין טקסט, תענה ללא." },
            { type: "image_url", image_url: { url: coverUrl } },
          ],
        },
      ],
    });
    const text = response.choices[0].message.content;
    return text === "ללא" ? null : text;
  } catch (e) {
    return null;
  }
}

async function indexVideos() {
  console.log("Starting index process...");

  const { data: videos, error } = await supabase.from("cached_videos").select("video_id").limit(3);
  if (error) {
    console.error("Supabase error:", error.message);
    return;
  }

  console.log("Found " + videos.length + " videos to process.");

  for (const video of videos) {
    const id = video.video_id;
    console.log("Processing: " + id);

    const { data: existing } = await supabase.from("video_analysis").select("aweme_id").eq("aweme_id", id).maybeSingle();
    if (existing) {
      console.log("Video already exists, skipping...");
      continue;
    }

    const videoData = await getVideoData(id);
    if (!videoData?.playUrl) continue;

    const onScreenText = await getOnScreenText(videoData.coverUrl);
    
    let transcript = "";
    try {
      const audioRes = await fetch(videoData.playUrl);
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      const file = await OpenAI.toFile(buffer, "video.mp4");
      const result = await openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "he",
        prompt: "סרטון שיווקי. אם יש רק מוזיקה, אל תתמלל כלום."
      });
      transcript = result.text;
    } catch (e) {
      console.log("Audio transcript failed, using vision only.");
    }

    try {
      const cleaningResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "אתה מומחה סושיאל מדיה ישראלי. תפקידך לקבל תמלול גולמי וטקסט מהמסך ולייצר תובנה שיווקית נקייה. תקן טעויות כמו תקרעו את התיאום לתקראו את התיאור. אם יש רק ג'יבריש מוזיקלי, תתעלם ממנו."
          },
          {
            role: "user",
            content: "תמלול אודיו: " + transcript + "\nטקסט מהמסך: " + onScreenText + "\nכותרת: " + videoData.title
          }
        ]
      });

      const finalResult = cleaningResponse.choices[0].message.content;

      await supabase.from("video_analysis").insert({
        aweme_id: id,
        transcript: finalResult,
        source_url: videoData.playUrl
      });
      
      console.log("Successfully processed: " + id);
    } catch (err) {
      console.error("Processing error:", err.message);
    }
  }
}

indexVideos().then(() => console.log("Done."));
