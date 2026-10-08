// Shared event data service. Mock events are anchored to the *upcoming*
// weekend so mock mode never serves stale, in-the-past events.
// Used by both the /events HTTP route and the FrameBot agent tools.
import { mockDistanceKm } from './geo';

export interface FreekendEvent {
  id: string;
  title: string;
  venue: string;
  date: string;
  time: string;
  category: string;
  price: string;
  image: null;
  url: string;
  distance_km?: number;
}

function upcomingWeekend(): { fri: string; sat: string; sun: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  // Days until Friday (if today is Fri/Sat/Sun, use *this* weekend)
  const toFri = day === 5 ? 0 : day === 6 ? -1 : day === 0 ? -2 : 5 - day;
  const fri = new Date(now);
  fri.setDate(now.getDate() + toFri);
  const sat = new Date(fri); sat.setDate(fri.getDate() + 1);
  const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
  return { fri: fmt(fri), sat: fmt(sat), sun: fmt(sun) };
}

function mockEvents(): Record<string, FreekendEvent[]> {
  const { fri, sat, sun } = upcomingWeekend();
  return {
    hyderabad: [
      { id: 'e1', title: 'Sunburn Arena ft. Martin Garrix', venue: 'Hitex Exhibition Centre', date: sat, time: '6:00 PM', category: 'Music', price: '₹1,500 onwards', image: null, url: 'https://in.bookmyshow.com' },
      { id: 'e2', title: 'Telugu Comedy Nights', venue: 'Shilpakala Vedika', date: fri, time: '7:30 PM', category: 'Comedy', price: '₹499 onwards', image: null, url: 'https://in.bookmyshow.com' },
      { id: 'e3', title: 'Hyderabad Literary Festival', venue: 'Hyderabad Public School', date: sun, time: '10:00 AM', category: 'Literature', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
      { id: 'e4', title: 'SRH vs MI — IPL Night', venue: 'Rajiv Gandhi International Stadium', date: sat, time: '7:30 PM', category: 'Sports', price: '₹800 onwards', image: null, url: 'https://in.bookmyshow.com' },
      { id: 'e5', title: 'Stand-up Special: Prudhvi Raj Live', venue: 'Bhumika Theatre', date: fri, time: '8:00 PM', category: 'Comedy', price: '₹399 onwards', image: null, url: 'https://in.bookmyshow.com' },
    ],
    visakhapatnam: [
      { id: 'e6', title: 'Beach Festival Vizag', venue: 'RK Beach', date: sat, time: '5:00 PM', category: 'Festival', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
      { id: 'e7', title: 'Vizag Music Mela', venue: 'Indoor Stadium', date: fri, time: '6:00 PM', category: 'Music', price: '₹299 onwards', image: null, url: 'https://in.bookmyshow.com' },
    ],
    vijayawada: [
      { id: 'e8', title: 'Krishna Pushkaralu Cultural Night', venue: 'Indira Gandhi Municipal Stadium', date: sun, time: '6:00 PM', category: 'Cultural', price: 'Free', image: null, url: 'https://in.bookmyshow.com' },
    ],
  };
}

export async function getEventsForCity(city: string, category?: string, lat?: number, lng?: number): Promise<FreekendEvent[]> {
  // Live source goes here when available; mock fallback keeps it working offline.
  const cityKey = city.toLowerCase();
  const all = mockEvents();
  let events = all[cityKey] || all['hyderabad'];
  if (category) {
    events = events.filter((e) => e.category.toLowerCase() === category.toLowerCase());
  }
  if (lat != null && lng != null) {
    // Mock mode: attach stable per-venue distances and sort near-first.
    events = events
      .map((e) => ({ ...e, distance_km: mockDistanceKm(e.id) }))
      .sort((a, b) => (a.distance_km as number) - (b.distance_km as number));
  }
  return events;
}
