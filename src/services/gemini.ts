import axios from 'axios';

const API_KEY = process.env.GEMINI_API_KEY;
const hasKey = () => API_KEY && API_KEY !== 'PASTE_WHEN_YOU_GET_IT';

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent`;

export function buildSystemPrompt(user: any, movies: any[], restaurants: any[], city: string): string {
  const ottList = user?.ott_subscriptions?.join(', ') || 'Netflix, Prime Video';
  const movieTitles = movies.slice(0, 5).map((m: any) => m.title).join(', ');
  const restNames = restaurants.slice(0, 5).map((r: any) => `${r.name} (${r.cuisine})`).join(', ');

  return `You are FrameBot, the AI Weekend Planner for Freekend app — the ultimate weekend discovery app for ${city}, Andhra Pradesh/Telangana.

CURRENT USER PROFILE:
- Name: ${user?.name || 'Friend'}
- City: ${city}
- OTT Subscriptions: ${ottList}

LIVE DATA — TOP MOVIES THIS WEEKEND (available on their OTTs):
${movieTitles}

LIVE DATA — TOP RESTAURANTS IN ${city.toUpperCase()}:
${restNames}

YOUR JOB:
1. Understand the user's mood, budget, and preferences from natural conversation
2. Build a personalized weekend plan (Saturday + Sunday timeline)
3. Suggest specific movies from the live data above
4. Suggest specific restaurants from the live data above
5. Add local events, activities, or day trips when relevant
6. Respond in the same language the user uses — Telugu, Tenglish (Telugu+English mix), or English
7. Be warm, fun, and conversational like a local best friend

RESPONSE FORMAT:
- Keep responses concise and friendly
- When suggesting a full plan, use this format:
  🎬 MOVIE: [title] on [OTT]
  🍽 DINNER: [restaurant] in [area]
  🎭 EVENT: [if any]
- End with "Plan save chesukunnava? (Shall I save this plan?)"

IMPORTANT:
- Always suggest places specific to ${city}
- Respect their OTT subscriptions — don't suggest platforms they don't have
- If they say they're bored, broke, or tired — adjust suggestions accordingly
- Telugu phrases to use: "Bagunnaara?" (How are you?), "Emi cheyalani undi?" (What do you want to do?), "Super choice!" (Great choice!)`;
}

export async function* streamGeminiResponse(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userMessage: string
): AsyncGenerator<string> {
  if (!hasKey()) {
    const mockResponse = `Nenu FrameBot! 🎬

Mee weekend plan ready chestha! ${userMessage.toLowerCase().includes('movie') ? 'Movie night ki perfect plan undi!' : 'Weekend ki super plan chestha!'}

🎬 MOVIE: RRR — Netflix lo available
🍽 DINNER: Paradise Biryani, Secunderabad
🎭 EVENT: Weekend special — Hussain Sagar lake walk

Plan save chesukunnava? (Shall I save this plan?)

*(Add your Gemini API key at aistudio.google.com to get real AI responses!)*`;

    // Simulate streaming
    const words = mockResponse.split(' ');
    for (const word of words) {
      yield word + ' ';
      await new Promise(r => setTimeout(r, 30));
    }
    return;
  }

  const contents = [
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  const response = await axios.post(
    `${GEMINI_URL}?key=${API_KEY}&alt=sse`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
    },
    { responseType: 'stream' }
  );

  let buffer = '';
  for await (const chunk of response.data) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {}
      }
    }
  }
}
