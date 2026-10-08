import axios from 'axios';

const API_KEY = process.env.GEMINI_API_KEY;
const hasKey = () => API_KEY && API_KEY !== 'PASTE_WHEN_YOU_GET_IT';

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent`;

export function buildSystemPrompt(
  user: any,
  movies: any[],
  restaurants: any[],
  city: string,
  language: string = 'English'
): string {
  const ottList = user?.ott_subscriptions?.join(', ') || 'Netflix, Prime Video';
  const movieTitles = movies.slice(0, 5).map((m: any) => m.title).join(', ');
  const restNames = restaurants.slice(0, 5).map((r: any) => `${r.name} (${r.cuisine || r.types?.[0] || 'restaurant'})`).join(', ');
  const displayCity = city.trim() || 'your city';

  return `You are FrameBot, the AI entertainment planner inside Freekend — the app where people chat about what they want to do and get real-time suggestions for movies, OTT shows, restaurants, local events, and travel plans, all in one place.

CURRENT USER PROFILE:
- Name: ${user?.name || 'Friend'}
- Location: ${displayCity}
- Preferred language: ${language}
- OTT Subscriptions: ${ottList}

LIVE DATA — MOVIES TRENDING NOW:
${movieTitles}

LIVE DATA — RESTAURANTS NEAR ${displayCity.toUpperCase()}:
${restNames}

YOUR JOB:
1. Understand the user's mood, budget, group (solo / couple / family / friends), and timing from natural conversation
2. Give real-time suggestions for movies, OTT picks, restaurants, local events, or travel/day trips — whatever they ask about
3. As the user AGREES to things, build their day: assemble the agreed items into one clear plan
4. Plans are NOT weekends-only — plan any day, evening, or trip they ask for
5. Respond in the user's preferred language (${language}). If they switch languages mid-conversation, follow them

RESPONSE FORMAT:
- Keep responses concise and friendly
- When presenting a full plan, use this format:
  🎬 MOVIE: [title] on [OTT / in theatres]
  🍽 FOOD: [restaurant] in [area]
  🎭 EVENT: [if any]
  ✈️ TRIP: [if travel or day trip]
- End a full plan with: "Want me to save this plan?"

IMPORTANT:
- Suggest places specific to ${displayCity} — real neighborhoods, real venues, adapted to any city or country the user names
- Respect their OTT subscriptions — don't suggest platforms they don't have
- If they say they're bored, broke, or tired — adjust suggestions accordingly
- Be warm, fun, and conversational, like a friend who knows the city well`;
}

export interface FrameBotContext {
  topMovie?: string;
  topRestaurant?: string;
  ottList?: string;
}

/** Raw contents-based SSE streamer (used by the agent loop after tool rounds). */
export async function* streamGeminiContents(
  systemPrompt: string,
  contents: Array<{ role: string; parts: any[] }>
): AsyncGenerator<string> {
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

export async function* streamGeminiResponse(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  userMessage: string,
  context: FrameBotContext = {}
): AsyncGenerator<string> {
  if (!hasKey()) {
    const movie = context.topMovie || 'the trending movie of the week';
    const restaurant = context.topRestaurant || 'a top-rated restaurant near you';
    const ott = context.ottList || 'Netflix, Prime Video';

    const mockResponse = `Hey! I'm FrameBot — your AI entertainment planner. 🎬

Based on what's popular right now, here's a plan for you:

🎬 MOVIE: ${movie} — streaming on ${ott}
🍽 FOOD: ${restaurant}
🎭 EVENT: Check the Events tab for what's on near you

Want me to save this plan? Say the word and we'll keep building your day — movies, food, events, even a day trip, all in one place.

*(Tip: add a Gemini API key from aistudio.google.com to unlock full real-time AI responses.)*`;

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

  yield* streamGeminiContents(systemPrompt, contents);
}
