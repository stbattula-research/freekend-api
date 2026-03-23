import { Router } from 'express';
import { getTrendingMovies, discoverMovies, searchMovies, getMovieDetails, POSTER_BASE } from '../services/tmdb';

export const moviesRouter = Router();

// GET /movies/trending
moviesRouter.get('/trending', async (req, res) => {
  try {
    const { page = '1' } = req.query;
    const data = await getTrendingMovies(Number(page));
    res.json({ ...data, poster_base: POSTER_BASE });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /movies/discover?genre=28&language=te&page=1
moviesRouter.get('/discover', async (req, res) => {
  try {
    const { genre, language, page = '1' } = req.query;
    const data = await discoverMovies(
      genre ? Number(genre) : undefined,
      language as string | undefined,
      Number(page)
    );
    res.json({ ...data, poster_base: POSTER_BASE });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /movies/search?q=RRR
moviesRouter.get('/search', async (req, res) => {
  try {
    const { q, page = '1' } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const data = await searchMovies(String(q), Number(page));
    res.json({ ...data, poster_base: POSTER_BASE });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /movies/:id
moviesRouter.get('/:id', async (req, res) => {
  try {
    const data = await getMovieDetails(Number(req.params.id));
    res.json({ ...data, poster_base: POSTER_BASE });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
