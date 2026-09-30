import http from 'node:http';
import { handler } from './lib/app.js';

const PORT = Number(process.env.PORT || 5890);
http.createServer(handler).listen(PORT, () => console.log(`PropGenie usage dashboard → http://localhost:${PORT}`));
