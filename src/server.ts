import { buildApp } from './app.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Pilot release gates are not complete. Production startup is disabled.');
const app = await buildApp({ directory: process.env.DATA_DIR, origin: process.env.APP_ORIGIN, logger: true });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4003) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close(); });
