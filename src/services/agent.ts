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
  /** Set when the user picked something that clashes with an existing item. */
  pendingAction: { kind: 'replace'; oldId: string; suggestion: Suggestion } | null;
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'plan'; plan: PlanItem[] }
  | { kind: 'suggestions'; suggestions: Suggestion[] };

export interface AgentTurnOptions {
  message: string;
  history?: Array<{ role: string; content: string }>;
  user?: any;
  city?: string;
  language?: string;
  sessionId: string;
  lat?: number;
  lng?: number;
}

// ---------------------------------------------------------------------------
// Plan store (in-memory; swap for a DB when auth/persistence lands)
// ---------------------------------------------------------------------------

const PLAN_STORE = new Map<string, SessionState>();

export function getOrCreateSession(sessionId: string): SessionState {
  let s = PLAN_STORE.get(sessionId);
  if (!s) {
    s = { items: [], lastSuggestions: [], itemSeq: 0, pendingAction: null };
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
  s.pendingAction = null;
  return s.items;
}

/** Change an item's display time (and recompute its concrete start). */
export function updatePlanItemTime(sessionId: string, itemId: string, time: string): PlanItem | null {
  const s = PLAN_STORE.get(sessionId);
  if (!s) return null;
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return null;
  item.time = time;
  item.startsAt = resolveStartsAt(time);
  return item;
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
    description: 'Find real restaurants near a city, optionally filtered by cuisine (e.g. biryani, seafood, italian). Pass lat/lng when the user shared their location for near-first results with distances.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search in' },
        cuisine: { type: 'string', description: 'Cuisine filter, e.g. biryani' },
        lat: { type: 'number', description: "User's latitude, when shared" },
        lng: { type: 'number', description: "User's longitude, when shared" },
      },
    },
  },
  {
    name: 'get_events',
    description: 'Get upcoming local events in a city, optionally filtered by category. Pass lat/lng when the user shared their location for near-first results with distances.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City to search in' },
        category: {
          type: 'string',
          description: 'One of: Music, Comedy, Sports, Festival, Cultural, Literature',
        },
        lat: { type: 'number', description: "User's latitude, when shared" },
        lng: { type: 'number', description: "User's longitude, when shared" },
      },
    },
  },
  {
    name: 'add_plan_item',
    description:
      'Add the user\'s PICK to their day plan. Suggestions are options, not decisions: add only the suggestion the user explicitly picked (by title, by ordinal like "first"/"option 2", or every suggestion only when they said "all"/"both"). A bare "yes"/"ok" with exactly one pending suggestion adds it; with several pending suggestions, add NOTHING and ask "Which one?" with a numbered list. If the call reports a conflict, do NOT add — ask the user whether to replace, and only then call again with replace_item_id.',
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
        replace_item_id: {
          type: 'string',
          description:
            'When the user confirmed replacing an existing item after a conflict was reported, pass that existing item\'s id here — it will be removed and the new item added in its place.',
        },
      },
      required: ['type', 'title', 'time'],
    },
  },
  {
    name: 'update_plan_item',
    description:
      'Change the time of an item already in the day plan ("move dinner to 8:30 PM", "push the movie to 9").',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Id of the plan item to move' },
        time: { type: 'string', description: 'New display time, e.g. "8:30 PM"' },
      },
      required: ['item_id', 'time'],
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

/** An item clashes when another item of the same type is already at the same time. */
export function findConflict(
  state: SessionState,
  type: PlanItemType,
  time: string,
  ignoreId?: string
): PlanItem | undefined {
  return state.items.find((i) => i.type === type && i.time === time && i.id !== ignoreId);
}

function withDistance(details: string, distanceKm: any): string {
  return distanceKm != null ? `${details} · ${distanceKm} km away` : details;
}

export async function executeTool(
  name: string,
  args: any,
  sessionId: string,
  city: string,
  lat?: number,
  lng?: number
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
      const data = await getNearbyRestaurants(
        String(a.city || city || 'hyderabad'),
        a.cuisine,
        a.lat ?? lat,
        a.lng ?? lng
      );
      const list = data.results.slice(0, 5).map((r: any) => ({
        name: r.name,
        cuisine: r.cuisine || (r.types && r.types[0]),
        rating: r.rating,
        area: r.vicinity,
        price: r.price_level ? '$'.repeat(Math.min(r.price_level, 4)) : undefined,
        open: r.open_now,
        distance_km: r.distance_km,
      }));
      state.lastSuggestions = data.results.slice(0, 3).map((r: any) => ({
        type: 'restaurant' as PlanItemType,
        title: r.name,
        details: withDistance(
          `${r.cuisine || 'restaurant'} · ${r.vicinity || ''}`.trim(),
          r.distance_km
        ),
        time: '9:00 PM',
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'get_events': {
      const events = await getEventsForCity(
        String(a.city || city || 'hyderabad'),
        a.category,
        a.lat ?? lat,
        a.lng ?? lng
      );
      const list = events.slice(0, 5).map((e) => ({
        title: e.title,
        venue: e.venue,
        date: e.date,
        time: e.time,
        category: e.category,
        price: e.price,
        distance_km: e.distance_km,
      }));
      state.lastSuggestions = events.slice(0, 3).map((e) => ({
        type: 'event' as PlanItemType,
        title: e.title,
        details: withDistance(`${e.venue} · ${e.price}`, e.distance_km),
        time: e.time,
      }));
      return { output: JSON.stringify(list), planChanged: false };
    }

    case 'add_plan_item': {
      const type = a.type as PlanItemType;
      const time = String(a.time || '7:00 PM');
      if (a.replace_item_id) {
        removePlanItem(sessionId, String(a.replace_item_id));
      } else {
        const conflict = findConflict(state, type, time);
        if (conflict) {
          // Double-booking is impossible: report it so the caller asks first.
          return {
            output: JSON.stringify({
              conflict: true,
              existing: conflict,
              message: `User already has "${conflict.title}" (${conflict.type}) at ${conflict.time}. Ask whether to replace it before adding.`,
            }),
            planChanged: false,
          };
        }
      }
      const item = addPlanItemInternal(
        sessionId,
        type,
        String(a.title || 'Untitled'),
        String(a.details || ''),
        time,
        a.startsAt
      );
      state.lastSuggestions = []; // consumed: the pick is now in the plan
      return {
        output: JSON.stringify({ added: item, plan: state.items }),
        planChanged: true,
      };
    }

    case 'update_plan_item': {
      const updated = updatePlanItemTime(sessionId, String(a.item_id || ''), String(a.time || ''));
      if (!updated) {
        return { output: JSON.stringify({ error: 'Item not found' }), planChanged: false };
      }
      const clash = findConflict(state, updated.type, updated.time, updated.id);
      return {
        output: JSON.stringify({
          updated,
          plan: state.items,
          clash: clash
            ? `Note: "${clash.title}" is also a ${clash.type} at ${clash.time}. Flag this to the user.`
            : null,
        }),
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

export function buildAgentSystemPrompt(
  user: any,
  city: string,
  language: string,
  lat?: number,
  lng?: number
): string {
  const base = buildSystemPrompt(user, [], [], city, language);
  const location =
    lat != null && lng != null
      ? `\nUSER LOCATION: ${lat},${lng} — pass lat/lng to search_restaurants and get_events. Results come back nearest-first with distances — always mention them ("0.8 km away"). Prefer nearby options when the user asks what's close.`
      : '';
  return `${base}${location}

AGENT TOOLS — you have real function tools. NEVER guess or invent movies, restaurants, or events from memory; always call the matching tool first.
- search_movies(query): find movies by title/keyword
- get_trending_movies(): this week's trending movies
- search_restaurants(city, cuisine?, lat?, lng?): real restaurants; pass lat/lng when you have them
- get_events(city, category?, lat?, lng?): upcoming local events; category one of Music, Comedy, Sports, Festival, Cultural, Literature
- add_plan_item(type, title, details, time, startsAt, replace_item_id?): add the user's PICK to the day plan
- update_plan_item(item_id, time): move a planned item to a new time
- remove_plan_item(item_id), get_plan()

RULES:
1. When the user asks for suggestions, call the relevant tool(s) FIRST, then present what came back as tappable cards (keep titles exact — the client renders them).
2. SELECTION — suggestions are options, not decisions. Add an item ONLY when the user picks it: explicit title ("rrr", "paradise biryani"), ordinal ("first", "second", "option 2"), or "all"/"both" (only then add every suggestion). A bare "yes"/"ok"/"book it" with exactly ONE pending suggestion adds it; with MULTIPLE pending suggestions, add NOTHING and ask "Which one?" with a numbered list.
3. NO DOUBLE-BOOKING — never add two items of the same type at the same time. If add_plan_item reports a conflict, ask "You've already got X at T — replace it with Y?" and only then call add_plan_item again with replace_item_id set to the existing item's id.
4. EDITS — "remove/cancel <title|type>", "change <type> to <title>", "move/push <type> to <time>", "clear my day": use remove_plan_item / add_plan_item with replace_item_id / update_plan_item. Confirm briefly after each change.
5. When calling add_plan_item, ALWAYS pass startsAt as a concrete ISO datetime for when the item starts. Interpret the agreed time as TODAY; if that time has already passed, use TOMORROW instead. Never pass a past datetime.
6. After the plan changes, summarize the day so far using the 🎬/🍽/🎭/✈️ format.`;
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

// ---------------------------------------------------------------------------
// Selection — suggestions are options; the user picks one (or explicitly all)
// ---------------------------------------------------------------------------

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st)\b/, 0],
  [/\b(second|2nd)\b/, 1],
  [/\b(third|3rd)\b/, 2],
  [/\b(fourth|4th)\b/, 3],
  [/\b(fifth|5th)\b/, 4],
];

function matchOrdinal(lower: string, n: number): number {
  for (const [re, i] of ORDINALS) {
    if (i < n && re.test(lower)) return i;
  }
  const patterns = [/(?:option|number|#)\s*(\d)/i, /^\s*(\d)\s*$/, /\b(?:pick|choose|take|go with)\s+(\d)/i];
  for (const p of patterns) {
    const m = p.exec(lower);
    if (m) {
      const i = parseInt(m[1], 10) - 1;
      if (i >= 0 && i < n) return i;
    }
  }
  return -1;
}

/** Match a suggestion by explicit title mention or ordinal ("first", "option 2"). */
function pickSuggestion(lower: string, suggestions: Suggestion[]): Suggestion | null {
  const padded = ` ${normTitle(lower)} `;
  // 1. Full normalized title contained in the message.
  const full = suggestions.filter((s) => padded.includes(` ${normTitle(s.title)} `));
  if (full.length > 0) return full[0];
  // 2. A distinctive long word unique to one suggestion's title.
  const words = new Set(padded.split(' ').filter((w) => w.length >= 5));
  const cands = suggestions.filter((s) => {
    const titleWords = new Set(normTitle(s.title).split(' ').filter((w) => w.length >= 5));
    const shared = [...words].filter((w) => titleWords.has(w));
    if (shared.length === 0) return false;
    return !suggestions.some(
      (o) => o !== s && shared.some((w) => normTitle(o.title).includes(w))
    );
  });
  if (cands.length === 1) return cands[0];
  // 3. Ordinal.
  const idx = matchOrdinal(lower, suggestions.length);
  return idx >= 0 ? suggestions[idx] : null;
}

/** "all of them" / "both" — the ONLY bulk-add trigger. */
function isBulkAgreement(lower: string): boolean {
  return AGREE_RE.test(lower) && /\b(all|both|everything|all of them|each one)\b/.test(lower);
}

function numberedList(suggestions: Suggestion[]): string {
  return suggestions.map((s, i) => `${i + 1}) ${s.title}`).join('\n');
}

/** True when the chosen suggestions can't all fit (same type at the same time). */
function hasMutualConflict(chosen: Suggestion[]): boolean {
  for (let a = 0; a < chosen.length; a++) {
    for (let b = a + 1; b < chosen.length; b++) {
      if (chosen[a].type === chosen[b].type && chosen[a].time === chosen[b].time) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conversational plan edits
// ---------------------------------------------------------------------------

const NO_RE = /^\s*(no|nope|nah|never ?mind|keep (it|them|that)|don't)\b/i;
const CLEAR_RE = /\b(clear|reset|start over|empty)\b/i;
const CLEAR_ALL_RE = /\bcancel\b.*\b(everything|all|day|plan)\b/i;
const REMOVE_RE = /\b(remove|cancel|drop|delete)\b/i;
const CHANGE_RE = /\b(change|switch|swap|replace)\b/i;
const INSTEAD_RE = /\binstead\b/i;
const RESCHED_RE = /\b(move|push|reschedule|shift)\b/i;
const ADD_TITLE_RE = /^\s*add\s+(.+?)\s*$/i;

function wantsClear(lower: string): boolean {
  return CLEAR_RE.test(lower) || CLEAR_ALL_RE.test(lower);
}

const TYPE_WORDS: Array<[RegExp, PlanItemType]> = [
  [/\b(movie|film|cinema|theatre|theater)\b/, 'movie'],
  [/\b(dinner|lunch|breakfast|brunch|restaurant|food|meal)\b/, 'restaurant'],
  [/\b(event|concert|comedy|show|match|game|festival)\b/, 'event'],
  [/\b(trip|activity|day trip)\b/, 'activity'],
];

function detectType(lower: string): PlanItemType | null {
  for (const [re, t] of TYPE_WORDS) {
    if (re.test(lower)) return t;
  }
  return null;
}

function hasEditIntent(lower: string): boolean {
  return (
    REMOVE_RE.test(lower) ||
    CHANGE_RE.test(lower) ||
    INSTEAD_RE.test(lower) ||
    RESCHED_RE.test(lower) ||
    wantsClear(lower) ||
    ADD_TITLE_RE.test(lower)
  );
}

/** Parse "8pm", "8:30 pm", "20:00" → "8:30 PM". Null when no time found. */
function parseTimeInput(lower: string): string | null {
  let m = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(lower);
  if (m) {
    let h = parseInt(m[1], 10);
    if (h < 1 || h > 12) return null;
    if (h === 12) h = 12;
    const hh = h % 12 === 0 ? 12 : h % 12;
    const ap = /p/i.test(m[3]) ? 'PM' : 'AM';
    return `${hh}:${m[2] ?? '00'} ${ap}`;
  }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(lower);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m[2]} ${ap}`;
  }
  return null;
}

/** Find a plan item by title mention or by type word (when unambiguous). */
function findPlanItem(
  state: SessionState,
  lower: string
): { item: PlanItem } | { ambiguous: PlanItem[] } | null {
  const byTitle = state.items.filter((i) => ` ${normTitle(lower)} `.includes(` ${normTitle(i.title)} `));
  if (byTitle.length === 1) return { item: byTitle[0] };
  if (byTitle.length > 1) return { ambiguous: byTitle };
  const t = detectType(lower);
  if (t) {
    const ofType = state.items.filter((i) => i.type === t);
    if (ofType.length === 1) return { item: ofType[0] };
    if (ofType.length > 1) return { ambiguous: ofType };
  }
  if (state.items.length === 1) return { item: state.items[0] };
  return null;
}

function suggestionLines(suggestions: Suggestion[]): string {
  return suggestions
    .map((s) => `${TYPE_EMOJI[s.type]} ${s.title} — ${s.details}`)
    .join('\n');
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOPWORDS = new Set(['it', 'this', 'that', 'one', 'them', 'those', 'these', 'something']);

/** Resolve a free-text title to a concrete suggestion via real search tools. */
async function resolveTitleToSuggestion(
  query: string,
  city: string,
  lat?: number,
  lng?: number
): Promise<Suggestion | null> {
  const q = query.trim();
  if (q.length < 2 || STOPWORDS.has(normTitle(q))) return null;
  try {
    const mq = await searchMovies(q);
    const hit = mq.results.find(
      (m: any) => normTitle(m.title).includes(normTitle(q)) || normTitle(q).includes(normTitle(m.title))
    );
    if (hit) {
      return {
        type: 'movie',
        title: hit.title,
        details: `★${hit.vote_average} · ${hit.release_date || ''}`,
        time: '7:00 PM',
      };
    }
  } catch {
    /* fall through to restaurants */
  }
  try {
    // Name match first ("Bawarchi"), then cuisine fallback ("italian").
    const rq = await getNearbyRestaurants(city, undefined, lat, lng);
    const byName = rq.results.find(
      (r: any) => normTitle(r.name).includes(normTitle(q)) || normTitle(q).includes(normTitle(r.name))
    );
    const r = byName || (await getNearbyRestaurants(city, q, lat, lng)).results[0];
    if (r) {
      return {
        type: 'restaurant',
        title: r.name,
        details: withDistance(
          `${r.cuisine || 'restaurant'} · ${r.vicinity || ''}`.trim(),
          r.distance_km
        ),
        time: '9:00 PM',
      };
    }
  } catch {
    /* fall through to events */
  }
  try {
    const events = await getEventsForCity(city);
    const e = events.find((ev) => normTitle(ev.title).includes(normTitle(q)));
    if (e) {
      return {
        type: 'event',
        title: e.title,
        details: withDistance(`${e.venue} · ${e.price}`, e.distance_km),
        time: e.time,
      };
    }
  } catch {
    /* no match */
  }
  return null;
}

async function doReschedule(
  state: SessionState,
  sessionId: string,
  lower: string,
  newTime: string
): Promise<{ reply: string; planChanged: boolean }> {
  const found = findPlanItem(state, lower);
  if (found && 'item' in found) {
    const clash = findConflict(state, found.item.type, newTime, found.item.id);
    if (clash) {
      return {
        reply: `That clashes with ${clash.title} at ${newTime} — pick another time?`,
        planChanged: false,
      };
    }
    const updated = updatePlanItemTime(sessionId, found.item.id, newTime);
    if (!updated) return { reply: `Hmm, that item disappeared — try again?`, planChanged: false };
    return {
      reply: `Moved ${TYPE_EMOJI[updated.type]} ${updated.title} to ${updated.time}.`,
      planChanged: true,
    };
  }
  if (found && 'ambiguous' in found) {
    return {
      reply: `Which one should I move?\n${found.ambiguous
        .map((i, n) => `${n + 1}) ${i.title} (${i.time})`)
        .join('\n')}`,
      planChanged: false,
    };
  }
  return {
    reply:
      state.items.length === 0
        ? `Your day is empty — nothing to move yet.`
        : `I couldn't find that in your day. Right now: ${state.items
            .map((i) => `${TYPE_EMOJI[i.type]} ${i.title} (${i.time})`)
            .join(', ')}.`,
    planChanged: false,
  };
}

async function doChange(
  state: SessionState,
  sessionId: string,
  city: string,
  lower: string,
  lat?: number,
  lng?: number
): Promise<{ reply: string; planChanged: boolean }> {
  let oldRef = '';
  let newTitle = '';
  const m = /(?:change|switch|swap)\s+(.+?)\s+to\s+(.+)/i.exec(lower);
  if (m) {
    oldRef = m[1].trim();
    newTitle = m[2].trim();
  } else {
    const m2 = /\binstead\b[^a-z]*?(?:let'?s\s+(?:do|go with|try)\s+|do\s+|go with\s+|try\s+)?(.+)/i.exec(
      lower
    );
    if (m2) {
      newTitle = m2[1].trim();
      oldRef = lower.replace(newTitle, '').trim();
    }
  }
  newTitle = newTitle.replace(/^(the|a|an)\s+/, '').trim();
  if (!newTitle) {
    return { reply: `What should I change it to? Say "change dinner to <place>".`, planChanged: false };
  }
  const found = oldRef ? findPlanItem(state, oldRef) : null;
  const target = found && 'item' in found ? found.item : null;
  if (!target) {
    if (found && 'ambiguous' in found) {
      return {
        reply: `Which one should I swap out?\n${found.ambiguous
          .map((i, n) => `${n + 1}) ${i.title} (${i.time})`)
          .join('\n')}`,
        planChanged: false,
      };
    }
    return {
      reply:
        state.items.length === 0
          ? `Your day is empty — tell me what you'd like to add first.`
          : `I couldn't tell which item to change. Your day has: ${state.items
              .map((i) => `${TYPE_EMOJI[i.type]} ${i.title}`)
              .join(', ')}.`,
      planChanged: false,
    };
  }
  // Resolve the new title: pending suggestion cards first, then a fresh search.
  let suggestion: Suggestion | null =
    state.lastSuggestions.length > 0 ? pickSuggestion(` ${newTitle} `, state.lastSuggestions) : null;
  if (!suggestion) {
    suggestion = await resolveTitleToSuggestion(newTitle, city, lat, lng);
  }
  if (!suggestion) {
    return { reply: `I couldn't find "${newTitle}". Try another name?`, planChanged: false };
  }
  // Keep the original time slot; the no-double-booking invariant still applies.
  const clash = findConflict(state, suggestion.type, target.time, target.id);
  if (clash) {
    return {
      reply: `That would double-book ${clash.title} at ${target.time} — remove it first or pick another time.`,
      planChanged: false,
    };
  }
  removePlanItem(sessionId, target.id);
  const item = addPlanItemInternal(
    sessionId,
    suggestion.type,
    suggestion.title,
    suggestion.details,
    target.time
  );
  state.lastSuggestions = [];
  return {
    reply: `Swapped ${target.title} for ${TYPE_EMOJI[item.type]} ${item.title} at ${item.time}.`,
    planChanged: true,
  };
}

async function* mockAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { message, city = 'hyderabad', language = 'English', sessionId, lat, lng } = opts;
  const lower = message.toLowerCase();
  const state = getOrCreateSession(sessionId);

  let reply = '';
  let planChanged = false;
  let suggestionsChanged = false;
  let handled = false;

  const nearNote = lat != null && lng != null ? ' near you' : '';

  // Explicit pick from pending suggestion cards (skipped for edit intents like
  // "remove RRR", which must never accidentally ADD).
  const editIntent = hasEditIntent(lower);
  const pick =
    state.lastSuggestions.length > 0 && !editIntent
      ? pickSuggestion(lower, state.lastSuggestions)
      : null;
  const bulk = state.lastSuggestions.length > 0 && !editIntent && isBulkAgreement(lower);
  const noPrefix = /^\s*no\b/i.test(lower);

  const askWhich = (suggestions: Suggestion[]): string =>
    `Which one?\n${numberedList(suggestions)}\nJust say the number or the name.`;

  const confirmAdd = (item: PlanItem): string =>
    `Done — ${TYPE_EMOJI[item.type]} ${item.title} (${item.time}) is in your day. Want to keep building — a movie, food, an event, or a day trip?`;

  /** Add one suggestion; on a clash, stage a replace question instead of adding. */
  const tryAdd = (
    s: Suggestion,
    timeOverride?: string
  ): { added?: PlanItem; reply: string; planChanged: boolean } => {
    const time = timeOverride || s.time || defaultTimeFor(s.type, message);
    const conflict = findConflict(state, s.type, time);
    if (conflict) {
      state.pendingAction = { kind: 'replace', oldId: conflict.id, suggestion: { ...s, time } };
      return {
        reply: `You've already got ${conflict.title} at ${conflict.time} — replace it with ${s.title}?`,
        planChanged: false,
      };
    }
    const item = addPlanItemInternal(sessionId, s.type, s.title, s.details, time);
    return { added: item, reply: confirmAdd(item), planChanged: true };
  };

  // 1. Resolve a pending replace question.
  if (state.pendingAction) {
    const pa = state.pendingAction;
    const pickMatchesPending =
      pick != null && normTitle(pick.title) === normTitle(pa.suggestion.title);
    if ((AGREE_RE.test(lower) && !pick && !bulk) || pickMatchesPending) {
      removePlanItem(sessionId, pa.oldId);
      const item = addPlanItemInternal(
        sessionId,
        pa.suggestion.type,
        pa.suggestion.title,
        pa.suggestion.details,
        pa.suggestion.time
      );
      state.pendingAction = null;
      state.lastSuggestions = [];
      planChanged = true;
      reply = `Swapped! ${TYPE_EMOJI[item.type]} ${item.title} (${item.time}) is now in your day.`;
      handled = true;
    } else if (NO_RE.test(lower)) {
      state.pendingAction = null;
      reply = `No problem — keeping your day as is.`;
      handled = true;
    } else {
      state.pendingAction = null; // user moved on; drop the stale question
    }
  }

  // 2. Explicit single pick ("rrr", "the first one", "option 2").
  if (!handled && pick && !bulk && !noPrefix) {
    const r = tryAdd(pick);
    reply = r.reply;
    planChanged = r.planChanged;
    if (r.added) state.lastSuggestions = [];
    else suggestionsChanged = true; // re-emit cards alongside the replace question
    handled = true;
  }

  // 2b. "no, the first one" — acknowledge, don't add.
  if (!handled && pick && noPrefix) {
    reply = `Got it — I won't add ${pick.title}. Tap another card or say its name whenever you're ready.`;
    suggestionsChanged = true;
    handled = true;
  }

  // 3. Explicit bulk pick ("all of them", "both") — only when nothing overlaps.
  if (!handled && bulk) {
    const chosen = state.lastSuggestions;
    const clashes = chosen.filter((s) => findConflict(state, s.type, s.time));
    if (hasMutualConflict(chosen) || clashes.length > 0) {
      reply = `Those overlap — I can't book them at the same time.\n${askWhich(chosen)}`;
      suggestionsChanged = true; // keep lastSuggestions so they can pick
    } else {
      const added = chosen.map((s) =>
        addPlanItemInternal(
          sessionId,
          s.type,
          s.title,
          s.details,
          s.time || defaultTimeFor(s.type, message)
        )
      );
      state.lastSuggestions = [];
      planChanged = true;
      reply =
        `Locked in! 🎉 I've added ${added
          .map((a) => `${TYPE_EMOJI[a.type]} ${a.title} (${a.time})`)
          .join(', ')} to your day. ` +
        `Want to keep building — a movie, food, an event, or a day trip? Just say the word.`;
    }
    handled = true;
  }

  // 4. Bare agreement ("yes", "ok", "book it") — but not when the message also
  // starts a fresh search ("yes, find me comedy" searches instead of adding).
  const freshIntent =
    MOVIE_RE.test(lower) || FOOD_RE.test(lower) || EVENT_RE.test(lower) || TRIP_RE.test(lower);
  if (!handled && AGREE_RE.test(lower) && !freshIntent && state.lastSuggestions.length > 0) {
    if (state.lastSuggestions.length === 1) {
      const r = tryAdd(state.lastSuggestions[0]);
      reply = r.reply;
      planChanged = r.planChanged;
      if (r.added) state.lastSuggestions = [];
      else suggestionsChanged = true;
    } else {
      reply = askWhich(state.lastSuggestions);
      suggestionsChanged = true; // keep suggestions; re-emit cards
    }
    handled = true;
  }

  // 5. Conversational edits: clear / remove / change / reschedule / add <title>.
  if (!handled && editIntent) {
    if (wantsClear(lower)) {
      clearPlan(sessionId);
      planChanged = true;
      reply = `Day cleared — fresh start. 🗑 What are we doing?`;
    } else if (REMOVE_RE.test(lower)) {
      const found = findPlanItem(state, lower);
      if (found && 'item' in found) {
        removePlanItem(sessionId, found.item.id);
        planChanged = true;
        reply = `Removed ${TYPE_EMOJI[found.item.type]} ${found.item.title} from your day.`;
      } else if (found && 'ambiguous' in found) {
        reply = `Which one should I remove?\n${found.ambiguous
          .map((i, n) => `${n + 1}) ${i.title} (${i.time})`)
          .join('\n')}`;
      } else {
        reply =
          state.items.length === 0
            ? `Your day is already empty — nothing to remove.`
            : `I couldn't find that in your day. Right now you've got: ${state.items
                .map((i) => `${TYPE_EMOJI[i.type]} ${i.title}`)
                .join(', ')}.`;
      }
    } else if (CHANGE_RE.test(lower) || INSTEAD_RE.test(lower)) {
      const asReschedule = parseTimeInput(lower);
      if (asReschedule) {
        const r = await doReschedule(state, sessionId, lower, asReschedule);
        reply = r.reply;
        planChanged = r.planChanged;
      } else {
        const r = await doChange(state, sessionId, city, lower, lat, lng);
        reply = r.reply;
        planChanged = r.planChanged;
      }
    } else if (RESCHED_RE.test(lower)) {
      const newTime = parseTimeInput(lower);
      if (!newTime) {
        reply = `What time should I move it to? (e.g. "8:30 PM")`;
      } else {
        const r = await doReschedule(state, sessionId, lower, newTime);
        reply = r.reply;
        planChanged = r.planChanged;
      }
    } else {
      // "add <title>"
      const m = ADD_TITLE_RE.exec(lower);
      const query = (m?.[1] || '').trim();
      if (STOPWORDS.has(normTitle(query))) {
        reply = `Which one? Tap a card or say its name.`;
      } else {
        const suggestion = await resolveTitleToSuggestion(query, city, lat, lng);
        if (!suggestion) {
          reply = `I couldn't find "${query}". Try "find me ..." first and pick from the cards.`;
        } else {
          const r = tryAdd(suggestion);
          reply = r.reply;
          planChanged = r.planChanged;
          if (r.added) state.lastSuggestions = [];
          else suggestionsChanged = true;
        }
      }
    }
    handled = true;
  }

  // 6. Fresh searches.
  if (!handled) {
    if (MOVIE_RE.test(lower)) {
      const qm = /(?:movie|film|watch)\s+(?:called|named|about)?\s*([a-z0-9 .'-]{2,})?/i.exec(lower);
      const query = (qm && qm[1] ? qm[1].trim() : '')
        .replace(/\b(tonight|today|tomorrow|please)\b/g, '')
        .trim();
      const tool = query ? 'search_movies' : 'get_trending_movies';
      const { output } = await executeTool(tool, { query }, sessionId, city, lat, lng);
      const movies = JSON.parse(output);
      if (!movies.length) {
        reply = `I couldn't find a movie matching "${query}" — want to try another title, or shall I suggest what's trending?`;
      } else {
        reply =
          `Here are some picks for you:\n${suggestionLines(state.lastSuggestions)}\n\n` +
          `Tap a card or tell me which one — say "the first one" or its name. 🎬`;
        suggestionsChanged = true;
      }
    } else if (FOOD_RE.test(lower)) {
      const cuisine = extractCuisine(lower);
      const { output } = await executeTool('search_restaurants', { city, cuisine }, sessionId, city, lat, lng);
      const spots = JSON.parse(output);
      if (!spots.length) {
        reply = `I couldn't find ${cuisine || 'restaurants'} near ${city} right now — want to try a different cuisine or city?`;
      } else {
        reply =
          `Great taste! Here are some spots${nearNote}:\n${suggestionLines(state.lastSuggestions)}\n\n` +
          `Tap a card or tell me which one — say "the first one" or its name. 🍽`;
        suggestionsChanged = true;
      }
    } else if (EVENT_RE.test(lower)) {
      const category = extractCategory(lower);
      const { output } = await executeTool('get_events', { city, category }, sessionId, city, lat, lng);
      const events = JSON.parse(output);
      if (!events.length) {
        reply = `Nothing ${category || ''} coming up in ${city} that I can see — want to check movies or food instead?`;
      } else {
        reply =
          `Here's what's on${nearNote}:\n${suggestionLines(state.lastSuggestions)}\n\n` +
          `Tap a card or tell me which one. 🎭`;
        suggestionsChanged = true;
      }
    } else if (TRIP_RE.test(lower)) {
      const suggestion: Suggestion = {
        type: 'activity',
        title: `${city} day trip`,
        details: 'lakeside walk, local food trail & sunset point',
        time: '10:00 AM',
      };
      state.lastSuggestions = [suggestion];
      suggestionsChanged = true;
      reply =
        `How about a day trip around ${city}? ✈️\n${suggestionLines([suggestion])}\n\n` +
        `Tap the card or say "yes" and I'll add it to your day.`;
    } else {
      const items = state.items;
      reply =
        items.length > 0
          ? `Your day so far has ${items.map((i) => `${TYPE_EMOJI[i.type]} ${i.title}`).join(', ')}. What next — a movie, food, an event, or a day trip?`
          : `Tell me what you're in the mood for — a movie, good food, an event, or a day trip — and I'll find real options and build your day as you pick. 🍿`;
    }
    handled = true;
  }

  // Simulate streaming word by word
  for (const word of reply.split(' ')) {
    yield { kind: 'text', text: word + ' ' };
    await delay(20);
  }
  if (suggestionsChanged && state.lastSuggestions.length > 0) {
    yield { kind: 'suggestions', suggestions: state.lastSuggestions };
  }
  if (planChanged) {
    yield { kind: 'plan', plan: getPlan(sessionId) };
  }
}

// Keyed agent — Gemini function-calling loop (up to 3 tool rounds) + stream
// ---------------------------------------------------------------------------

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const hasGeminiKey = () => GEMINI_KEY && GEMINI_KEY !== 'PASTE_WHEN_YOU_GET_IT';
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`;

async function* keyedAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentEvent> {
  const { message, history = [], user = {}, city = 'hyderabad', language = 'English', sessionId } = opts;
  const systemPrompt = buildAgentSystemPrompt(user, city, language, opts.lat, opts.lng);
  const state = getOrCreateSession(sessionId);
  const beforeSuggestions = JSON.stringify(state.lastSuggestions);

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
      const result = await executeTool(name, args || {}, sessionId, city, opts.lat, opts.lng);
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

  // Surface fresh suggestions as tappable cards, then stream the final reply.
  if (
    state.lastSuggestions.length > 0 &&
    JSON.stringify(state.lastSuggestions) !== beforeSuggestions
  ) {
    yield { kind: 'suggestions', suggestions: state.lastSuggestions };
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
