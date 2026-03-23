import { Router } from 'express';
import { getNearbyRestaurants } from '../services/places';

export const restaurantsRouter = Router();

// GET /restaurants?city=hyderabad&cuisine=biryani
restaurantsRouter.get('/', async (req, res) => {
  try {
    const { city = 'hyderabad', cuisine } = req.query;
    const data = await getNearbyRestaurants(String(city), cuisine as string | undefined);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
