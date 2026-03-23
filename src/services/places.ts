import axios from 'axios';

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const hasKey = () => API_KEY && API_KEY !== 'PASTE_WHEN_YOU_GET_IT';

const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  hyderabad:     { lat: 17.3850, lng: 78.4867 },
  visakhapatnam: { lat: 17.6868, lng: 83.2185 },
  vijayawada:    { lat: 16.5062, lng: 80.6480 },
  warangal:      { lat: 17.9784, lng: 79.5941 },
  tirupati:      { lat: 13.6288, lng: 79.4192 },
  guntur:        { lat: 16.3008, lng: 80.4428 },
  karimnagar:    { lat: 18.4386, lng: 79.1288 },
  khammam:       { lat: 17.2473, lng: 80.1514 },
};

const MOCK_RESTAURANTS: Record<string, any[]> = {
  hyderabad: [
    { place_id: 'hyd1', name: 'Paradise Biryani', rating: 4.5, vicinity: 'Secunderabad', price_level: 2, types: ['restaurant'], cuisine: 'Biryani', open_now: true },
    { place_id: 'hyd2', name: 'Ohri\'s Banjara', rating: 4.3, vicinity: 'Banjara Hills', price_level: 3, types: ['restaurant'], cuisine: 'Multi-cuisine', open_now: true },
    { place_id: 'hyd3', name: 'Pesarattu Junction', rating: 4.2, vicinity: 'Jubilee Hills', price_level: 1, types: ['restaurant'], cuisine: 'Andhra', open_now: true },
    { place_id: 'hyd4', name: 'Chutneys', rating: 4.4, vicinity: 'Banjara Hills', price_level: 2, types: ['restaurant'], cuisine: 'South Indian', open_now: true },
    { place_id: 'hyd5', name: 'Bawarchi', rating: 4.1, vicinity: 'RTC X Roads', price_level: 1, types: ['restaurant'], cuisine: 'Biryani', open_now: false },
    { place_id: 'hyd6', name: 'Cream Stone', rating: 4.6, vicinity: 'Jubilee Hills', price_level: 2, types: ['cafe'], cuisine: 'Desserts & Ice Cream', open_now: true },
  ],
  visakhapatnam: [
    { place_id: 'vsk1', name: 'Bamboo Bay', rating: 4.4, vicinity: 'Beach Road', price_level: 2, types: ['restaurant'], cuisine: 'Seafood', open_now: true },
    { place_id: 'vsk2', name: 'Masala Trail', rating: 4.2, vicinity: 'Dwaraka Nagar', price_level: 2, types: ['restaurant'], cuisine: 'North Indian', open_now: true },
    { place_id: 'vsk3', name: 'Zara\'s', rating: 4.3, vicinity: 'MVP Colony', price_level: 3, types: ['restaurant'], cuisine: 'Multi-cuisine', open_now: true },
  ],
  vijayawada: [
    { place_id: 'vjw1', name: 'Hotel Swagath Grand', rating: 4.2, vicinity: 'MG Road', price_level: 2, types: ['restaurant'], cuisine: 'Andhra', open_now: true },
    { place_id: 'vjw2', name: 'Minerva Coffee Shop', rating: 4.0, vicinity: 'Benz Circle', price_level: 1, types: ['cafe'], cuisine: 'South Indian', open_now: true },
  ],
};

export async function getNearbyRestaurants(city: string, cuisine?: string) {
  const cityKey = city.toLowerCase();

  if (!hasKey()) {
    let results = MOCK_RESTAURANTS[cityKey] || MOCK_RESTAURANTS['hyderabad'];
    if (cuisine) results = results.filter(r => r.cuisine.toLowerCase().includes(cuisine.toLowerCase()));
    return { results, mock: true };
  }

  const coords = CITY_COORDS[cityKey] || CITY_COORDS['hyderabad'];
  const keyword = cuisine ? `${cuisine} restaurant` : 'restaurant';

  const res = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
    params: {
      key: API_KEY,
      location: `${coords.lat},${coords.lng}`,
      radius: 5000,
      type: 'restaurant',
      keyword,
    }
  });
  return { results: res.data.results, mock: false };
}
