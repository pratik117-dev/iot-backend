import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import {
  connectMqtt, disconnectMqtt,
  getMqttStatus, getMqttConfig,
  publishMqtt, injectPayload,
  MqttConfig,
} from '../services/mqtt';
import { wss } from '../index';

const router = Router();
router.use(authenticate);

// GET /api/mqtt/status
router.get('/status', (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { status: getMqttStatus(), config: getMqttConfig() } });
});

// POST /api/mqtt/connect
router.post('/connect', requireAdmin, [
  body('host').trim().notEmpty().withMessage('Host is required'),
  body('port').isInt({ min: 1, max: 65535 }),
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  body('topicPrefix').trim().notEmpty(),
  body('useTls').isBoolean(),
], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });

  const config: MqttConfig = {
    host:        req.body.host,
    port:        parseInt(req.body.port),
    username:    req.body.username,
    password:    req.body.password,
    topicPrefix: req.body.topicPrefix,
    useTls:      req.body.useTls !== false && req.body.useTls !== 'false',
    clientId:    req.body.clientId || `envirologapp-${Date.now()}`,
  };

  try {
    await connectMqtt(config, wss);
    res.json({ success: true, message: 'MQTT connection initiated', data: getMqttStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mqtt/disconnect
router.post('/disconnect', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await disconnectMqtt();
    res.json({ success: true, message: 'MQTT disconnected', data: getMqttStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mqtt/publish  — publish via HiveMQ broker (requires live connection)
router.post('/publish', requireAdmin, [
  body('topic').trim().notEmpty(),
  body('payload').isObject(),
], (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });

  const ok = publishMqtt(req.body.topic, req.body.payload);
  if (!ok) return res.status(503).json({ success: false, error: 'MQTT not connected' });
  res.json({ success: true, message: 'Published to HiveMQ' });
});

// POST /api/mqtt/inject  — inject JSON directly into the pipeline (no broker needed)
// Simulates exactly what happens when a real Arduino message arrives:
//   JSON → parse → DB → WebSocket broadcast → alerts
router.post('/inject', requireAdmin, [
  body('deviceId').trim().notEmpty().withMessage('deviceId is required'),
  body('payload').isObject().withMessage('payload must be a JSON object'),
], async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });

  try {
    const result = await injectPayload(req.body.deviceId, req.body.payload, wss);
    res.json({ success: true, message: 'Payload injected into pipeline', data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mqtt/test-publish — publish preset payload via HiveMQ
router.post('/test-publish', requireAdmin, async (req: AuthRequest, res: Response) => {
  const { prisma } = await import('../lib/prisma');
  const config = getMqttConfig();
  if (!config) return res.status(503).json({ success: false, error: 'MQTT not configured' });

  // Try to find any ONLINE device, fallback to first device
  let device = await prisma.device.findFirst({ where: { status: 'ONLINE' } });
  if (!device) device = await prisma.device.findFirst();
  if (!device) return res.status(404).json({ success: false, error: 'No devices found — create one first' });

  const prefix  = config.topicPrefix.replace(/\/$/, '');
  const topic   = `${prefix}/${device.name}/data`;
  const payload = {
    device_id:   device.name,
    temperature: parseFloat((60 + Math.random() * 20).toFixed(2)),
    humidity:    parseFloat((40 + Math.random() * 20).toFixed(2)),
    air_quality: Math.floor(80 + Math.random() * 100),
    flame:       Math.random() > 0.85,
    timestamp:   new Date().toISOString(),
  };

  const ok = publishMqtt(topic, payload);
  if (!ok) return res.status(503).json({ success: false, error: 'MQTT not connected — use /inject instead' });

  res.json({ success: true, message: `Published to ${topic}`, data: { topic, payload } });
});

export default router;
