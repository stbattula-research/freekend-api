import axios from 'axios';
import { randomUUID } from 'crypto';
import { buildSystemPrompt, streamGeminiContents } from './gemini';
import { getTrendingMovies, searchMovies } from './tmdb';
import { getNearbyRestaurants } from './places';
import { getEventsForCity } from './events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanItemType = 'movie' | 'restaurant' | 'event' | 'activity';

export interface PlanItem {
  id: string;
  type: PlanItemType;
  title: string;
  details: string;
  /** Display string, e.g. "7:00 PM" */
  time: string;
  /** Concrete ISO timestamp for when the item starts — always in the future */
  startsAt: string;
}

export interface Suggestion {
  type: PlanItemType;
  title: string;
  details: string;
  time: string;
}

interface SessionState {
  items: PlanItem[];
  lastSuggestions: Suggestion[];
  itemSeq: number;
}

export type AgentEvent = { kind: 'text'; text: string } | { kind: 'plan'; plan: PlanItem[] };

export interface AgentTurnOptions {
  message: string;
  history?: Array<{ role: string; content: string }>;
  user?: any;
  city?: string;
  language?: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Plan store (in-memory; swap for a DB when auth/persistence lands)
// ---------------------------------------------------------------------------

const PLAN_STORE = new Map<string, SessionState>();

export function getOrCreateSession(sessionId: string): SessionState {
  let s = PLAN_STORE.get(sessionId);
  if (!s) {
    s = { items: [], lastSuggestions: [], itemSeq: 0 };
    PLAN_STORE.set(sessionId, s);
  }
  return s;
}

export function getPlan(sessionId: string): PlanItem[] {
  return getOrCreateSession(sessionId).items;
}

export function removePlanItem(sessionId: string, itemId: string): PlanItem[] | null {
  const s = PLAN_STORE.get(sessionId);
  if (!s) return null;
  const before = s.items.length;
  s.items = s.items.filter((i) => i.id !== itemId);
  return s.items.length === before ? null : s.items;
}

export function clearPlan(sessionId: string): PlanItem[] {
  const s = getOrCreateSession(sessionId);
  s.items = [];
  s.lastSuggestions = [];
  return s.items;
}

// ---------------------------------------------------------------------------
// Time resolution — display times become concrete future ISO timestamps.
// "7:00 PM" means today at 7pm; if that already passed, tomorrow at 7pm.
// ---------------------------------------------------------------------------

export function resolveStartsAt(timeStr: string): string {
  const now = new Date();
  const m = /(\d{1,2}):(\d{2})\s*([AP])\.?M\.?/i.exec(timeStr || '');
  if (!m) {
    // Fallback: one hour from now
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  }
  let h = parseInt(m[1], 10) % 12;
  if (/p/i.test(m[3])) h += 12;
  const d = new Date(now);
  d.setHours(h, parseInt(m[2], 10), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** Normalize a model-supplied startsAt: must be a valid future ISO, else recompute. */
function normalizeStartsAt(startsAt: any, time: string): string {
  const t = startsAt ? Date.parse(startsAt) : NaN;
  if (!isNaN(t) && t > Date.now()) return new Date(t).toISOString();
  return resolveStartsAt(time);
}

function defaultTimeFor(type: PlanItemType, message: string): string {
  const lower = message.toLowerCase();
  if (type === 'movie') return '7:00 PM';
  if (type === 'activity') return '10:00 AM';
  if (type === 'restaurant') {
    if (/\bbreakfast\b/.test(lower)) return '9:00 AM';
    if (/\blunch\b/.test(lower)) return '1:00 PM';
    return '9:00 PM'; // dinner default
  }
  return '7:00 PM';
}

function addPlanItemInternal(
  sessionId: string,
  type: PlanItemType,
  title: string,
  details: string,
  time: string,
  startsAt?: string
): PlanItem {
  const s = getOrCreateSession(sessionId);
  const item: PlanItem = {
    id: `p${++s.itemSeq}`,
    type,
    title,
    details,
    time,
    startsAt: normalizeStartsAt(startsAt, time),
  };
  s.items.push(item);
  return item;
}

// ---------------------------------------------------------------------------
// Tool definitions (Gemini function declarations)
// ---------------------------------------------------------------------------

export const TOOL_DECLARATIONS = [
  {
    name: 'search_movies',
    description: 'Search movies by title or keyword. Returns matching movies with title, rating, overview.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Movie title or keyword to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'get_trending_movies',
    description: "Get this week's trending movies. Use when the user wants a movie but names nothing specific.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'search_restaurants',
    description: 'Find real restaurants near a city, optionally filtered by cuisine (e.g. biryani, seafood, italian).',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search in' },
        cuisine: { type: 'string', description: 'Cuisine filter, e.g. biryani' },
      },
    },
  },
  {
    name: 'get_events',
    description: 'Get upcoming local events in a city, optionally filtered by category.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search in' },
        category: {
          type: 'string',
          description: 'One of: Music, Comedy, Sports, Festival, Cultural, Literature',
        },
      },
    },
  },
  {
    name: 'add_plan_item',
    description:
      'Add an agreed item to the user\'s day plan. Call this THE MOMENT the user agrees to a suggestion ("yes", "sounds good", "let\'s do it", "book it").',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'One of: movie, restaurant, event, activity' },
        title: { type: 'string', description: 'Item title' },
        details: { type: 'string', description: 'Short details (area, venue, OTT, price…)' },
        time: { type: 'string', description: 'Display time, e.g. "7:00 PM"' },
        startsAt: {
          type: 'string',
          description:
            'Concrete ISO datetime for when the item starts. Interpret the agreed time as today; if that time already passed, use tomorrow. Never a past datetime.',
        },
      },
      required: ['type', 'title', 'time'],
    },
  },
  {
    name: 'remove_plan_item',
    description: 'Remove an item from the day plan by its id.',
    parameters: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
    },
  },
  {
    name: 'get_plan',
    description: 'Read the current day plan items.',
    parameters: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Tool execution — dispatches to the REAL local services, never hardcoded data
// ---------------------------------------------------------------------------

interface ToolResult {
  output: string;
  planChanged: boolean;
}

const TYPE_EMOJI: Record<PlanItemType, string> = {
  movie: '🎬',
  restaurant: '🍽',
  event: '🎭',
  activity: '✈️',
};

export async function executeTool(
  name: string,
  args: any,
  sessionId: string,
  city: string
): Promise<ToolResult> {
  const state = getOrCreateSession(sessionId);
  const a = args || {};

  switch (name) {
    case 'search_movies': {
      const data = await searchMovies(String(a.query || ''));
      const list = data.results.slice(0, 5).map((m: any) => ({
        title: m.title,
        rating: m.vote_average,
        release: m.release_date,
        overview: (m.overview || '').slice(0, 120),
      }));
      state.lastSuggestions = data.results.slice(0, 3).map((m: any) => ({
        type: 'movie' as PlanItemType,
        title: m.title,
        details: `★${m.vote_average} · ${m.release_date || ''}`,
        time: '7:00 PM',
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'get_trending_movies': {
      const data = await getTrendingMovies(1);
      const list = data.results.slice(0, 5).map((m: any) => ({
        title: m.title,
        rating: m.vote_average,
        release: m.release_date,
      }));
      state.lastSuggestions = data.results.slice(0, 3).map((m: any) => ({
        type: 'movie' as PlanItemType,
        title: m.title,
        details: `★${m.vote_average} · ${m.release_date || ''}`,
        time: '7:00 PM',
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'search_restaurants': {
      const data = await getNearbyRestaurants(String(a.city || city || 'hyderabad'), a.cuisine);
      const list = data.results.slice(0, 5).map((r: any) => ({
        name: r.name,
        cuisine: r.cuisine || (r.types && r.types[0]),
        rating: r.rating,
        area: r.vicinity,
        price: r.price_level ? '$'.repeat(Math.min(r.price_level, 4)) : undefined,
        open: r.open_now,
      }));
      state.lastSuggestions = data.results.slice(0, 3).map((r: any) => ({
        type: 'restaurant' as PlanItemType,
        title: r.name,
        details: `${r.cuisine || 'restaurant'} · ${r.vicinity || ''}`.trim(),
        time: '9:00 PM',
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'get_events': {
      const events = await getEventsForCity(String(a.city || city || 'hyderabad'), a.category);
      const list = events.slice(0, 5).map((e) => ({
        title: e.title,
        venue: e.venue,
        date: e.date,
        time: e.time,
        category: e.category,
        price: e.price,
      }));
      state.lastSuggestions = events.slice(0, 3).map((e) => ({
        type: 'event' as PlanItemType,
        title: e.title,
        details: `${e.venue} · ${e.price}`,
        time: e.time,
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'add_plan_item': {
      const item = addPlanItemInternal(
        sessionId,
        a.type,
        String(a.title || 'Untitled'),
        String(a.details || ''),
        String(a.time || '7:00 PM'),
        a.startsAt
      );
      return {
        output: JSON.stringify({ added: item, plan: state.items }),
        planChanged: true,
      };
    }

    case 'remove_plan_item': {
      const items = removePlanItem(sessionId, String(a.item_id || ''));
      return {
        output: JSON.stringify({ removed: !!items, plan: items || state.items }),
        planChanged: !!items,
      };
    }

    case 'get_plan': {
      return { output: JSON.stringify(state.items), planChanged: false };
    }

    default:
      return { output: JSON.stringify({ error: `Unknown tool: ${name}` }), planChanged: false };
  }
}

// ---------------------------------------------------------------------------
// Agent system prompt — base prompt + TOOLS section
// ---------------------------------------------------------------------------

export function buildAgentSystemPrompt(user: any, city: string, language: string): string {
  const base = buildSystemPrompt(user, [], [], city, language);
  return `${base}

AGENT TOOLS — you have real function tools. NEVER guess or invent movies, restaurants, or events from memory; always call the matching tool first.
- search_movies(query): find movies by title/keyword
- get_trending_movies(): this week's trending movies
- search_restaurants(city, cuisine?): real restaurants near the city, optionally filtered (e.g. "biryani")
- get_events(city, category?): upcoming local events; category one of Music, Comedy, Sports, Festival, Cultural, Literature
- add_plan_item(type, title, details, time, startsAt): add an AGREED item to the user's day plan
- remove_plan_item(item_id), get_plan()

RULES:
1. When the user asks for suggestions, call the relevant tool(s) FIRST, then present what came back.
2. The moment the user AGREES ("yes", "yeah", "ok", "sounds good", "let's do it", "book it"), call add_plan_item for each suggestion they agreed to — do not just describe the plan in text.
3. When calling add_plan_item, ALWAYS pass startsAt as a concrete ISO datetime for when the item starts. Interpret the agreed time as TODAY; if that time has already passed, use TOMORROW instead. Never pass a past datetime.
4. After the plan changes, summarize the day so far using the 🎬/🍽/🎭/✈️ format.`;
}

// ---------------------------------------------------------------------------
// Mock agent — same executeTool path, keyword-routed (no Gemini key needed)
// ---------------------------------------------------------------------------

const AGREE_RE = /\b(yes|yeah|yep|ok|okay|sure|sounds good|let'?s do it|book it|do it|confirmed|perfect|go for it)\b/i;
const MOVIE_RE = /\b(movie|movies|film|films|watch|ott|netflix|theatre|theater|cinema)\b/i;
const FOOD_RE = /\b(restaurant|food|eat|dinner|lunch|breakfast|biryani|hungry|cafe|brunch)\b/i;
const EVENT_RE = /\b(event|events|concert|comedy|show|music|match|game|festival|exhibition|play)\b/i;
const TRIP_RE = /\b(trip|travel|day trip|daytrip|vacation|getaway|weekend trip|road trip)\b/i;

const KNOWN_CUISINES = [
  'biryani', 'andhra', 'chinese', 'italian', 'seafood', 'north indian', 'south indian',
  'continental', 'mexican', 'thai', 'cafe', 'desserts', 'arabian', 'mughlai',
];

function extractCuisine(lower: string): string | undefined {
  return KNOWN_CUISINES.find((c) => lower.includes(c));
}

function extractCategory(lower: string): string | undefined {
  if (/\b(music|concert|dj)\b/.test(lower)) return 'Music';
  if (/\b(comedy|stand[\s-]?up)\b/.test(lower)) return 'Comedy';
  if (/\b(sport|cricket|match|game|ipl)\b/.test(lower)) return 'Sports';
  if (/\bfestival\b/.test(lower)) return 'Festival';
  if (/\b(literature|book|literary)\b/.test(lower)) return 'Literature';
  if (/\bcultur/.test(lower)) return 'Cultural';
  return undefined;
}

function suggestionLines(suggestions: Suggestion[]): string {
  return suggestions
    .map((s) => `${TYPE_EMOJI[s.type]} ${s.title} — ${s.details}`)
    .join('\n');
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* mockAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { message, city = 'hyderabad', language = 'English', sessionId } = opts;
  const lower = message.toLowerCase();
  const state = getOrCreateSession(sessionId);

  let reply = '';
  let planChanged = false;

  if (AGREE_RE.test(lower) && state.lastSuggestions.length > 0) {
    const added: PlanItem[] = [];
    for (const s of state.lastSuggestions) {
      added.push(
        addPlanItemInternal(sessionId, s.type, s.title, s.details, s.time || defaultTimeFor(s.type, message))
      );
    }
    state.lastSuggestions = [];
    planChanged = true;
    reply =
      `Locked in! 🎉 I've added ${added.map((a) => `${TYPE_EMOJI[a.type]} ${a.title} (${a.time})`).join(', ')} to your day. ` +
      `Want to keep building — a movie, food, an event, or a day trip? Just say the word.`;
  } else if (MOVIE_RE.test(lower)) {
    const qm = /(?:movie|film|watch)\s+(?:called|named|about)?\s*([a-z0-9 .'-]{2,})?/i.exec(lower);
    const query = (qm && qm[1] ? qm[1].trim() : '').replace(/\b(tonight|today|tomorrow|please)\b/g, '').trim();
    const tool = query ? 'search_movies' : 'get_trending_movies';
    const { output } = await executeTool(tool, { query }, sessionId, city);
    const movies = JSON.parse(output);
    if (!movies.length) {
      reply = `I couldn't find a movie matching "${query}" — want to try another title, or shall I suggest what's trending?`;
    } else {
      reply =
        `Here are some picks for you:\n${suggestionLines(state.lastSuggestions)}\n\n` +
        `Like any of these? Say "yes" and I'll add them to your day. 🎬`;
    }
  } else if (FOOD_RE.test(lower)) {
    const cuisine = extractCuisine(lower);
    const { output } = await executeTool('search_restaurants', { city, cuisine }, sessionId, city);
    const spots = JSON.parse(output);
    if (!spots.length) {
      reply = `I couldn't find ${cuisine || 'restaurants'} near ${city} right now — want to try a different cuisine or city?`;
    } else {
      reply =
        `Great taste! Here are some spots in ${city}:\n${suggestionLines(state.lastSuggestions)}\n\n` +
        `Say "yes" to lock one (or all) into your day. 🍽`;
    }
  } else if (EVENT_RE.test(lower)) {
    const category = extractCategory(lower);
    const { output } = await executeTool('get_events', { city, category }, sessionId, city);
    const events = JSON.parse(output);
    if (!events.length) {
      reply = `Nothing ${category || ''} coming up in ${city} that I can see — want to check movies or food instead?`;
    } else {
      reply =
        `Here's what's on in ${city}:\n${suggestionLines(state.lastSuggestions)}\n\n` +
        `Say "yes" and I'll add them to your day. 🎭`;
    }
  } else if (TRIP_RE.test(lower)) {
    const suggestion: Suggestion = {
      type: 'activity',
      title: `${city} day trip`,
      details: 'lakeside walk, local food trail & sunset point',
      time: '10:00 AM',
    };
    state.lastSuggestions = [suggestion];
    reply =
      `How about a day trip around ${city}? ✈️\n${suggestionLines([suggestion])}\n\n` +
      `Say "yes" and I'll add it to your day.`;
  } else {
    const items = state.items;
    reply =
      items.length > 0
        ? `Your day so far has ${items.map((i) => `${TYPE_EMOJI[i.type]} ${i.title}`).join(', ')}. What next — a movie, food, an event, or a day trip?`
        : `Tell me what you're in the mood for — a movie, good food, an event, or a day trip — and I'll find real options and build your day as you pick. 🍿`;
  }

  // Simulate streaming word by word
  for (const word of reply.split(' ')) {
    yield { kind: 'text', text: word + ' ' };
    await delay(20);
  }
  if (planChanged) {
    yield { kind: 'plan', plan: getPlan(sessionId) };
  }
}

// ---------------------------------------------------------------------------
// Keyed agent — Gemini function-calling loop (up to 3 tool rounds) + stream
// ---------------------------------------------------------------------------

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const hasGeminiKey = () => GEMINI_KEY && GEMINI_KEY !== 'PASTE_WHEN_YOU_GET_IT';
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`;

async function* keyedAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { message, history = [], user = {}, city = 'hyderabad', language = 'English', sessionId } = opts;
  const systemPrompt = buildAgentSystemPrompt(user, city, language);

  let contents: Array<{ role: string; parts: any[] }> = [
    ...history.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  // Up to 3 non-streamed tool rounds
  for (let round = 0; round < 3; round++) {
    const res = await axios.post(
      `${GENERATE_URL}?key=${GEMINI_KEY}`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools: [{ function_declarations: TOOL_DECLARATIONS }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }
    );

    const parts: any[] = res.data?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (calls.length === 0) {
      contents = [...contents, { role: 'model', parts }];
      break;
    }

    const responses: any[] = [];
    let planChanged = false;
    for (const c of calls) {
      const { name, args } = c.functionCall;
      const result = await executeTool(name, args || {}, sessionId, city);
      if (result.planChanged) planChanged = true;
      responses.push({
        functionResponse: { name, response: { result: result.output } },
      });
    }

    contents = [
      ...contents,
      { role: 'model', parts },
      { role: 'function', parts: responses },
    ];

    if (planChanged) {
      yield { kind: 'plan', plan: getPlan(sessionId) };
    }
  }

  // Final streaming pass over the tool-augmented conversation
  for await (const chunk of streamGeminiContents(systemPrompt, contents)) {
    yield { kind: 'text', text: chunk };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function newSessionId(): string {
  return randomUUID();
}

export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  if (hasGeminiKey()) {
    yield* keyedAgentTurn(opts);
  } else {
    yield* mockAgentTurn(opts);
  }
}
