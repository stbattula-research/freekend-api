import { Router } from 'express';
import { getEventsForCity } from '../services/events';

export const eventsRouter = Router();

// GET /events?city=hyderabad&category=Music
eventsRouter.get('/', async (req, res) => {
  try {
    const { city = 'hyderabad', category } = req.query;
    const cityKey = String(city).toLowerCase();
    const events = await getEventsForCity(cityKey, category as string | undefined);
    res.json({ results: events, city: cityKey, note: 'Connect BookMyShow API for live events' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
