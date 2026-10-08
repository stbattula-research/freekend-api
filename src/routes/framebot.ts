import { Router, Request, Response } from 'express';
import {
  runAgentTurn,
  newSessionId,
  getPlan,
  removePlanItem,
  clearPlan,
} from '../services/agent';

export const framebotRouter = Router();

// POST /framebot/chat  (SSE streaming: {"text"} chunks, {"suggestions"} pick cards,
// {"plan"} updates, {"done":true,"sessionId"})
framebotRouter.post('/chat', async (req: Request, res: Response) => {
  const {
    message,
    history = [],
    user = {},
    city = 'hyderabad',
    language = 'English',
    sessionId: clientSessionId,
    lat: latRaw,
    lng: lngRaw,
  } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });

  const sessionId = clientSessionId || newSessionId();

  const toCoord = (v: any, max: number): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= max ? n : undefined;
  };
  const lat = toCoord(latRaw, 90);
  const lng = toCoord(lngRaw, 180);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    for await (const event of runAgentTurn({ message, history, user, city, language, sessionId, lat, lng })) {
      if (event.kind === 'text') {
        res.write(`data: ${JSON.stringify({ text: event.text })}\n\n`);
      } else if (event.kind === 'plan') {
        res.write(`data: ${JSON.stringify({ plan: { items: event.plan } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ suggestions: event.suggestions })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, sessionId })}\n\n`);
    res.end();
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// GET /plans/:sessionId — read the current day plan
framebotRouter.get('/plans/:sessionId', (req: Request, res: Response) => {
  res.json({ sessionId: req.params.sessionId, items: getPlan(String(req.params.sessionId)) });
});

// DELETE /plans/:sessionId/items/:itemId — remove one item
framebotRouter.delete('/plans/:sessionId/items/:itemId', (req: Request, res: Response) => {
  const items = removePlanItem(String(req.params.sessionId), String(req.params.itemId));
  if (!items) return res.status(404).json({ error: 'Plan or item not found' });
  res.json({ sessionId: req.params.sessionId, items });
});

// POST /plans/:sessionId/clear — empty the day plan
framebotRouter.post('/plans/:sessionId/clear', (req: Request, res: Response) => {
  res.json({ sessionId: req.params.sessionId, items: clearPlan(String(req.params.sessionId)) });
});
