import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';
import {
  connectMqtt,
  disconnectMqtt,
  getMqttStatus,
  getMqttConfig,
  publishMqtt,
  MqttConfig,
} from '../services/mqtt';
import { wss } from '../index';
import { prisma } from '../lib/prisma';

const router = Router();
router.use(authenticate);

// ── GET /api/mqtt/status ─────────────────────────────────────────────────────
router.get('/status', (req: AuthRequest, res: Response) => {
  res.json({
    success: true,
    data: {
      status: getMqttStatus(),
      config: getMqttConfig(),
    },
  });
});

// ── POST /api/mqtt/connect ───────────────────────────────────────────────────
router.post(
  '/connect',
  requireAdmin,
  [
    body('host').trim().notEmpty().withMessage('Broker host is required'),
    body('port').isInt({ min: 1, max: 65535 }).withMessage('Port must be 1–65535'),
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
    body('topicPrefix').trim().notEmpty().withMessage('Topic prefix is required'),
    body('useTls').isBoolean(),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

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
  }
);

// ── POST /api/mqtt/disconnect ────────────────────────────────────────────────
router.post('/disconnect', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await disconnectMqtt();
    res.json({ success: true, message: 'MQTT disconnected', data: getMqttStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/mqtt/publish ───────────────────────────────────────────────────
router.post(
  '/publish',
  requireAdmin,
  [
    body('topic').trim().notEmpty().withMessage('Topic is required'),
    body('payload').isObject().withMessage('Payload must be an object'),
  ],
  (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const ok = publishMqtt(req.body.topic, req.body.payload);
    if (!ok) {
      return res.status(503).json({ success: false, error: 'MQTT not connected' });
    }
    res.json({ success: true, message: 'Message published' });
  }
);

// ── POST /api/mqtt/test-publish ──────────────────────────────────────────────
router.post('/test-publish', requireAdmin, async (req: AuthRequest, res: Response) => {
  const device = await prisma.device.findFirst({ where: { status: 'ONLINE' } });
  if (!device) {
    return res.status(404).json({ success: false, error: 'No ONLINE devices found' });
  }

  const config = getMqttConfig();
  if (!config) {
    return res.status(503).json({ success: false, error: 'MQTT not configured' });
  }

  const prefix  = config.topicPrefix.replace(/\/$/, '');
  const topic   = `${prefix}/sensors/${device.id}`;
  const payload = {
    temperature: parseFloat((20 + Math.random() * 15).toFixed(1)),
    humidity:    parseFloat((40 + Math.random() * 40).toFixed(1)),
    co2:         parseFloat((400 + Math.random() * 800).toFixed(0)),
    pm25:        parseFloat((5   + Math.random() * 40).toFixed(1)),
    pm10:        parseFloat((10  + Math.random() * 80).toFixed(1)),
    noise:       parseFloat((30  + Math.random() * 50).toFixed(1)),
  };

  const ok = publishMqtt(topic, payload);
  if (!ok) {
    return res.status(503).json({ success: false, error: 'MQTT not connected' });
  }

  res.json({
    success: true,
    message: `Test payload published to ${topic}`,
    data: { topic, payload },
  });
});

export default router;