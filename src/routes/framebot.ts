import { Router, Request, Response } from 'express';
import { buildSystemPrompt, streamGeminiResponse } from '../services/gemini';
import { getTrendingMovies } from '../services/tmdb';
import { getNearbyRestaurants } from '../services/places';

export const framebotRouter = Router();

// POST /framebot/chat  (SSE streaming)
framebotRouter.post('/chat', async (req: Request, res: Response) => {
  const { message, history = [], user = {}, city = 'hyderabad', language = 'English' } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // Fetch live context data
    const [moviesData, restaurantsData] = await Promise.all([
      getTrendingMovies(1),
      getNearbyRestaurants(city),
    ]);

    const systemPrompt = buildSystemPrompt(user, moviesData.results, restaurantsData.results, city, language);

    // Context for the no-API-key mock fallback so it stays data-driven
    const context = {
      topMovie: moviesData.results?.[0]?.title,
      topRestaurant: restaurantsData.results?.[0]?.name,
      ottList: user?.ott_subscriptions?.join(', '),
    };

    // Stream the response
    for await (const chunk of streamGeminiResponse(systemPrompt, history, message, context)) {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});
