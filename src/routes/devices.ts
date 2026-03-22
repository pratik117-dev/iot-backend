import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();

// ─────────────────────────────────────────────
// PUBLIC ROUTES (no authentication required)
// Must be defined BEFORE router.use(authenticate)
// ─────────────────────────────────────────────

// Public: return basic device info only — no user-sensitive data
// Used by IoT simulators and internal services
router.get('/public', async (_req, res: Response) => {
  try {
    const devices = await prisma.device.findMany({
      select: {
        id: true,
        name: true,
        location: true,
        type: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch public devices' });
  }
});

// ─────────────────────────────────────────────
// PROTECTED ROUTES (authentication required)
// authenticate middleware applied from this point on
// ─────────────────────────────────────────────
router.use(authenticate);

// Dashboard stats — must be defined BEFORE /:id to avoid
// Express matching "stats/dashboard" as a dynamic :id param
router.get('/stats/dashboard', async (req: AuthRequest, res: Response) => {
  try {
    const where = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };

    const [totalDevices, onlineDevices, activeAlerts] = await Promise.all([
      prisma.device.count({ where }),
      prisma.device.count({ where: { ...where, status: 'ONLINE' } }),
      prisma.alert.count({
        where: {
          resolved: false,
          device: { ...where },
        },
      }),
    ]);

    // Get latest readings for averages
    const recentData = await prisma.sensorData.findMany({
      where: { device: { ...where } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const avg = (arr: (number | null)[]) => {
      const nums = arr.filter(n => n !== null) as number[];
      return nums.length ? parseFloat((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1)) : 0;
    };

    const avgTemp       = avg(recentData.map(d => d.temperature));
    const avgHumidity   = avg(recentData.map(d => d.humidity));
    const avgCo2        = avg(recentData.map(d => d.co2));
    const avgPm25       = avg(recentData.map(d => d.pm25));
    const avgAirQuality = avg(recentData.map(d => (d as any).airQuality));

    // Count flame detections in the last 50 readings
    const flameCount = recentData.filter(d => (d as any).flame === true).length;

    // AQI: prefer raw airQuality from Arduino if available, else derive from PM2.5
    let aqi = avgAirQuality || 0;
    if (!aqi) {
      if (avgPm25 <= 12) aqi = Math.round((50 / 12) * avgPm25);
      else if (avgPm25 <= 35.4) aqi = Math.round(50 + ((100 - 51) / (35.4 - 12.1)) * (avgPm25 - 12.1));
      else if (avgPm25 <= 55.4) aqi = Math.round(101 + ((150 - 101) / (55.4 - 35.5)) * (avgPm25 - 35.5));
      else aqi = Math.min(Math.round(151 + (avgPm25 - 55.5) * 2), 500);
    }

    res.json({
      success: true,
      data: {
        totalDevices,
        onlineDevices,
        activeAlerts,
        avgTemperature: avgTemp,
        avgHumidity,
        avgCo2,
        avgPm25,
        avgAirQuality,
        flameCount,
        airQualityIndex: aqi,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Get all devices (admin sees all, user sees own)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const where = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };
    const devices = await prisma.device.findMany({
      where,
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch devices' });
  }
});

// Get single device by ID
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const device = await prisma.device.findFirst({
      where: {
        id: req.params.id,
        ...(req.user!.role !== 'ADMIN' && { userId: req.user!.id }),
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
        sensorData: { orderBy: { createdAt: 'desc' }, take: 20 },
        alerts: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    res.json({ success: true, data: device });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch device' });
  }
});

// Create device
router.post('/', [
  body('name').trim().notEmpty(),
  body('location').trim().notEmpty(),
  body('type').isIn(['AIR_QUALITY', 'WEATHER', 'NOISE', 'WATER', 'MULTI_SENSOR']),
], async (req: AuthRequest, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { name, location, type, userId } = req.body;
    const assignedUserId = req.user!.role === 'ADMIN' && userId ? userId : req.user!.id;

    const device = await prisma.device.create({
      data: { name, location, type, userId: assignedUserId, status: 'OFFLINE' },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    await prisma.systemLog.create({
      data: { action: 'DEVICE_CREATED', userId: req.user!.id, details: `Device: ${name}` },
    });

    res.status(201).json({ success: true, data: device });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to create device' });
  }
});

// Update device
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.device.findFirst({
      where: {
        id: req.params.id,
        ...(req.user!.role !== 'ADMIN' && { userId: req.user!.id }),
      },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Device not found' });

    const { name, location, type, status } = req.body;
    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: {
        ...(name     && { name }),
        ...(location && { location }),
        ...(type     && { type }),
        ...(status   && { status }),
      },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    res.json({ success: true, data: device });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update device' });
  }
});

// Delete device
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.device.findFirst({
      where: {
        id: req.params.id,
        ...(req.user!.role !== 'ADMIN' && { userId: req.user!.id }),
      },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Device not found' });

    await prisma.device.delete({ where: { id: req.params.id } });

    await prisma.systemLog.create({
      data: { action: 'DEVICE_DELETED', userId: req.user!.id, details: `Device: ${existing.name}` },
    });

    res.json({ success: true, message: 'Device deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete device' });
  }
});

export default router;