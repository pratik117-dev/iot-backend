import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Get sensor data with filters
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      deviceId,
      startDate,
      endDate,
      limit = '100',
      page = '1',
    } = req.query;

    const take = Math.min(parseInt(limit as string), 500);
    const skip = (parseInt(page as string) - 1) * take;

    const deviceWhere = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };

    const where: any = {
      device: { ...deviceWhere },
      ...(deviceId && { deviceId: deviceId as string }),
      ...(startDate || endDate ? {
        createdAt: {
          ...(startDate && { gte: new Date(startDate as string) }),
          ...(endDate && { lte: new Date(endDate as string) }),
        },
      } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.sensorData.findMany({
        where,
        include: { device: { select: { id: true, name: true, location: true } } },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.sensorData.count({ where }),
    ]);

    res.json({ success: true, data, total, page: parseInt(page as string), limit: take });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch sensor data' });
  }
});

// Get latest reading per device
router.get('/latest', async (req: AuthRequest, res: Response) => {
  try {
    const deviceWhere = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };
    const devices = await prisma.device.findMany({
      where: { ...deviceWhere, status: 'ONLINE' },
      select: { id: true },
    });

    const latestData = await Promise.all(
      devices.map(async (d) => {
        const latest = await prisma.sensorData.findFirst({
          where: { deviceId: d.id },
          orderBy: { createdAt: 'desc' },
          include: { device: { select: { id: true, name: true, location: true } } },
        });
        return latest;
      })
    );

    res.json({ success: true, data: latestData.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch latest data' });
  }
});

// Get time-series data for charts
router.get('/timeseries', async (req: AuthRequest, res: Response) => {
  try {
    const { deviceId, metric = 'temperature', hours = '24' } = req.query;
    const since = new Date(Date.now() - parseInt(hours as string) * 60 * 60 * 1000);

    const deviceWhere = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };

    const data = await prisma.sensorData.findMany({
      where: {
        device: { ...deviceWhere },
        ...(deviceId && { deviceId: deviceId as string }),
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        temperature: true,
        humidity: true,
        co2: true,
        pm25: true,
        pm10: true,
        noise: true,
        ph: true,
        turbidity: true,
        device: { select: { name: true } },
      },
    });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch time-series data' });
  }
});

export default router;
