import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// Get alerts
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { resolved, severity, limit = '50', page = '1' } = req.query;
    const take = Math.min(parseInt(limit as string), 200);
    const skip = (parseInt(page as string) - 1) * take;

    const deviceWhere = req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id };

    const where: any = {
      device: { ...deviceWhere },
      ...(resolved !== undefined && { resolved: resolved === 'true' }),
      ...(severity && { severity: severity as string }),
    };

    const [alerts, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        include: { device: { select: { id: true, name: true, location: true } } },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.alert.count({ where }),
    ]);

    res.json({ success: true, data: alerts, total, page: parseInt(page as string), limit: take });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
});

// Resolve alert
router.patch('/:id/resolve', async (req: AuthRequest, res: Response) => {
  try {
    const alert = await prisma.alert.findFirst({
      where: {
        id: req.params.id,
        device: req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id },
      },
    });

    if (!alert) return res.status(404).json({ success: false, error: 'Alert not found' });

    const updated = await prisma.alert.update({
      where: { id: req.params.id },
      data: { resolved: true },
      include: { device: { select: { id: true, name: true } } },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to resolve alert' });
  }
});

// Resolve all alerts for a device
router.patch('/device/:deviceId/resolve-all', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.alert.updateMany({
      where: {
        deviceId: req.params.deviceId,
        resolved: false,
        device: req.user!.role === 'ADMIN' ? {} : { userId: req.user!.id },
      },
      data: { resolved: true },
    });

    res.json({ success: true, message: 'All alerts resolved' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to resolve alerts' });
  }
});

export default router;
