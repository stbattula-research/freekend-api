import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export const app = express();

app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 100 }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Freekend API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Routes — will be added in Sprint 2, 3, 4
// app.use('/movies',      moviesRouter);
// app.use('/restaurants', restaurantsRouter);
// app.use('/framebot',    framebotRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});