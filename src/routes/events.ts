import { Router } from 'express';

export const eventsRouter = Router();

const MOCK_EVENTS: Record<string, any[]> = {
  hyderabad: [
    { id: 'e1', title: 'Sunburn Arena ft. Martin Garrix', venue: 'Hitex Exhibition Centre', date: '2025-03-29', time: '6:00 PM', category: 'Music', price: '₹1,500 onwards', image: null, url: 'https://in.bookmyshow.com' },
    { id: 'e2', title: 'Telugu Comedy Nights', venue: 'Shilpakala Vedika', date: '2025-03-28', time: '7:30 PM', category: 'Comedy', price: '₹499 onwards', image: null, url: 'https://in.bookmyshow.com' },
    { id: 'e3', title: 'Hyderabad Literary Festival', venue: 'Hyderabad Public School', date: '2025-03-30', time: '10:00 AM', category: 'Literature', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
    { id: 'e4', title: 'IPL 2025: SRH vs MI', venue: 'Rajiv Gandhi International Stadium', date: '2025-03-27', time: '7:30 PM', category: 'Sports', price: '₹800 onwards', image: null, url: 'https://in.bookmyshow.com' },
    { id: 'e5', title: 'Stand-up Special: Prudhvi Raj Live', venue: 'Bhumika Theatre', date: '2025-03-29', time: '8:00 PM', category: 'Comedy', price: '₹399 onwards', image: null, url: 'https://in.bookmyshow.com' },
  ],
  visakhapatnam: [
    { id: 'e6', title: 'Beach Festival Vizag', venue: 'RK Beach', date: '2025-03-29', time: '5:00 PM', category: 'Festival', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
    { id: 'e7', title: 'Vizag Music Mela', venue: 'Indoor Stadium', date: '2025-03-28', time: '6:00 PM', category: 'Music', price: '₹299 onwards', image: null, url: 'https://in.bookmyshow.com' },
  ],
  vijayawada: [
    { id: 'e8', title: 'Krishna Pushkaralu Cultural Night', venue: 'Indira Gandhi Municipal Stadium', date: '2025-03-30', time: '6:00 PM', category: 'Cultural', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
  ],
};

// GET /events?city=hyderabad&category=Music
eventsRouter.get('/', async (req, res) => {
  try {
    const { city = 'hyderabad', category } = req.query;
    const cityKey = String(city).toLowerCase();
    let events = MOCK_EVENTS[cityKey] || MOCK_EVENTS['hyderabad'];
    if (category) events = events.filter(e => e.category.toLowerCase() === String(category).toLowerCase());
    res.json({ results: events, city: cityKey, note: 'Connect BookMyShow API for live events' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
