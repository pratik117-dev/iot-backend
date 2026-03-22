import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import authRoutes   from './routes/auth';
import deviceRoutes from './routes/devices';
import dataRoutes   from './routes/data';
import alertRoutes  from './routes/alerts';
import adminRoutes  from './routes/admin';
import reportRoutes from './routes/reports';
import mqttRoutes   from './routes/mqtt';

import { setupWebSocket }        from './services/websocket';
import { startSensorSimulation } from './services/simulator';
import { autoConnectFromEnv }    from './services/mqtt';
import { errorHandler }          from './middleware/errorHandler';
import { prisma }                from './lib/prisma';

dotenv.config();

const app        = express();
const httpServer = createServer(app);
export const wss = new WebSocketServer({ server: httpServer });

const PORT = process.env.PORT || 3001;

// ── Security & middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/data',    dataRoutes);
app.use('/api/alerts',  alertRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/mqtt',    mqttRoutes);

app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);
app.get('/api/docs', (_req, res) => res.json({
  openapi: '3.0.0',
  info: { title: 'EnviroLog API', version: '1.1.0' },
  paths: {
    '/api/auth/register':     { post: { summary: 'Register' } },
    '/api/auth/login':        { post: { summary: 'Login' } },
    '/api/devices':           { get: { summary: 'List devices' }, post: { summary: 'Create device' } },
    '/api/data':              { get: { summary: 'Sensor readings' } },
    '/api/alerts':            { get: { summary: 'Alerts' } },
    '/api/mqtt/status':       { get: { summary: 'MQTT connection status' } },
    '/api/mqtt/connect':      { post: { summary: 'Connect to HiveMQ Cloud' } },
    '/api/mqtt/disconnect':   { post: { summary: 'Disconnect MQTT' } },
    '/api/mqtt/publish':      { post: { summary: 'Publish a message' } },
    '/api/mqtt/test-publish': { post: { summary: 'Publish a test reading' } },
  },
}));

app.use(errorHandler);

// ── WebSocket ──────────────────────────────────────────────────────────────────
setupWebSocket(wss);

// ── Simulator ─────────────────────────────────────────────────────────────────
// Always starts. When HIVEMQ_HOST is set, both run simultaneously —
// real device data comes via MQTT, simulated data fills the rest.
// Set ENABLE_SIMULATOR=false in .env to disable if you don't want it.
const simulatorEnabled = process.env.ENABLE_SIMULATOR !== 'false';
if (simulatorEnabled) {
  startSensorSimulation(wss);
  console.log('🤖 Simulator: ENABLED (runs alongside real IoT data)');
} else {
  console.log('🤖 Simulator: DISABLED');
}

// ── Start server ───────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(`\n🌍 EnviroLog Server  →  port ${PORT}`);
  console.log(`📡 WebSocket         →  ready`);
  console.log(`🔗 Client URL        →  ${process.env.CLIENT_URL || 'http://localhost:5173'}`);
  console.log(`🐝 HiveMQ Host       →  ${process.env.HIVEMQ_HOST || '(not configured)'}\n`);

  try {
    await prisma.$connect();
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ Database connection failed:', err);
  }

  // Auto-connect to HiveMQ if credentials exist in .env
  autoConnectFromEnv(wss);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
