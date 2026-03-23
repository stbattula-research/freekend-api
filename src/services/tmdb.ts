import axios from 'axios';

const TMDB_BASE = 'https://api.themoviedb.org/3';
export const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';

const API_KEY = process.env.TMDB_API_KEY;
const hasKey = () => API_KEY && API_KEY !== 'PASTE_WHEN_YOU_GET_IT';

const MOCK_MOVIES = [
  { id: 1, title: 'RRR', overview: 'An epic tale of two legendary Indian warriors and their journey away from home before they began to fight for their country in the 1920s.', poster_path: null, vote_average: 7.9, release_date: '2022-03-24', genre_ids: [28, 18], original_language: 'te' },
  { id: 2, title: 'Pushpa: The Rise', overview: 'A labourer rises up the ranks of a red sandalwood smuggling syndicate in the forests of Andhra Pradesh.', poster_path: null, vote_average: 7.6, release_date: '2021-12-17', genre_ids: [28, 80], original_language: 'te' },
  { id: 3, title: 'Baahubali 2: The Conclusion', overview: 'When Shiva, the son of Bahubali, learns about his heritage, he begins to question the choices made by his tribe.', poster_path: null, vote_average: 8.2, release_date: '2017-04-28', genre_ids: [28, 18, 12], original_language: 'te' },
  { id: 4, title: 'Ala Vaikunthapurramuloo', overview: 'A man raised by the wrong family discovers his true identity and must reclaim his rightful place.', poster_path: null, vote_average: 7.8, release_date: '2020-01-12', genre_ids: [28, 35], original_language: 'te' },
  { id: 5, title: 'Uppena', overview: 'A love story between a young fisherman and a girl from a higher social class.', poster_path: null, vote_average: 7.5, release_date: '2021-02-12', genre_ids: [18, 10749], original_language: 'te' },
  { id: 6, title: 'HanuMan', overview: 'A small-time thief from a fictional village accidentally acquires superpowers from a divine jewel.', poster_path: null, vote_average: 8.1, release_date: '2024-01-12', genre_ids: [28, 14], original_language: 'te' },
  { id: 7, title: 'Kalki 2898-AD', overview: 'Set in a dystopian future, a story of a bounty hunter, a scientist, and a pregnant woman whose unborn child holds the fate of the universe.', poster_path: null, vote_average: 6.8, release_date: '2024-06-27', genre_ids: [878, 28], original_language: 'te' },
  { id: 8, title: 'Devara: Part 1', overview: 'A gangster who ruled the seas with fear, and the story of his legacy passed to his son.', poster_path: null, vote_average: 6.5, release_date: '2024-09-27', genre_ids: [28, 18], original_language: 'te' },
];

export async function getTrendingMovies(page = 1) {
  if (!hasKey()) return { results: MOCK_MOVIES, total_pages: 1, page: 1, mock: true };
  const res = await axios.get(`${TMDB_BASE}/trending/movie/week`, {
    params: { api_key: API_KEY, page, region: 'IN' }
  });
  return res.data;
}

export async function discoverMovies(genreId?: number, language?: string, page = 1) {
  if (!hasKey()) {
    let results = MOCK_MOVIES;
    if (genreId) results = results.filter(m => m.genre_ids.includes(genreId));
    return { results, total_pages: 1, page: 1, mock: true };
  }
  const params: any = { api_key: API_KEY, page, region: 'IN', sort_by: 'popularity.desc' };
  if (genreId) params.with_genres = genreId;
  if (language) params.with_original_language = language;
  const res = await axios.get(`${TMDB_BASE}/discover/movie`, { params });
  return res.data;
}

export async function searchMovies(query: string, page = 1) {
  if (!hasKey()) {
    return { results: MOCK_MOVIES.filter(m => m.title.toLowerCase().includes(query.toLowerCase())), total_pages: 1, page: 1, mock: true };
  }
  const res = await axios.get(`${TMDB_BASE}/search/movie`, {
    params: { api_key: API_KEY, query, page, region: 'IN' }
  });
  return res.data;
}

export async function getMovieDetails(id: number) {
  if (!hasKey()) return MOCK_MOVIES.find(m => m.id === id) || MOCK_MOVIES[0];
  const res = await axios.get(`${TMDB_BASE}/movie/${id}`, {
    params: { api_key: API_KEY, append_to_response: 'videos,credits' }
  });
  return res.data;
}
