import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate, requireAdmin);

// Get all users
router.get('/users', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, name: true, role: true, createdAt: true,
        _count: { select: { devices: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// Update user role
router.patch('/users/:id/role', async (req: AuthRequest, res: Response) => {
  try {
    const { role } = req.body;
    if (!['ADMIN', 'USER'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, email: true, name: true, role: true },
    });

    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// Delete user
router.delete('/users/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (req.params.id === req.user!.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete yourself' });
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

// Get system logs
router.get('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', page = '1' } = req.query;
    const take = parseInt(limit as string);
    const skip = (parseInt(page as string) - 1) * take;

    const [logs, total] = await Promise.all([
      prisma.systemLog.findMany({ orderBy: { createdAt: 'desc' }, take, skip }),
      prisma.systemLog.count(),
    ]);

    res.json({ success: true, data: logs, total });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

// System overview stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [totalUsers, totalDevices, onlineDevices, totalAlerts, unresolvedAlerts, totalReadings] = await Promise.all([
      prisma.user.count(),
      prisma.device.count(),
      prisma.device.count({ where: { status: 'ONLINE' } }),
      prisma.alert.count(),
      prisma.alert.count({ where: { resolved: false } }),
      prisma.sensorData.count(),
    ]);

    res.json({
      success: true,
      data: { totalUsers, totalDevices, onlineDevices, totalAlerts, unresolvedAlerts, totalReadings },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch admin stats' });
  }
});

export default router;
