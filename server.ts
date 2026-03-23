import 'dotenv/config';
import { app } from './src/app';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🎬 Freekend API running on port ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/health`);
});