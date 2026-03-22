import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@envirologapp.com' },
    update: {},
    create: {
      email: 'admin@envirologapp.com',
      password: adminPassword,
      name: 'Admin User',
      role: 'ADMIN',
    },
  });

  // Create regular user
  const userPassword = await bcrypt.hash('user123', 12);
  const user = await prisma.user.upsert({
    where: { email: 'user@envirologapp.com' },
    update: {},
    create: {
      email: 'user@envirologapp.com',
      password: userPassword,
      name: 'Demo User',
      role: 'USER',
    },
  });

  // Create devices
  const devices = await Promise.all([
    prisma.device.upsert({
      where: { id: 'device-001' },
      update: { status: 'ONLINE' },
      create: {
        id: 'device-001',
        name: 'Air Monitor Alpha',
        location: 'Main Office - Floor 1',
        type: 'AIR_QUALITY',
        status: 'ONLINE',
        userId: admin.id,
      },
    }),
    prisma.device.upsert({
      where: { id: 'device-002' },
      update: { status: 'ONLINE' },
      create: {
        id: 'device-002',
        name: 'Weather Station Beta',
        location: 'Rooftop',
        type: 'WEATHER',
        status: 'ONLINE',
        userId: admin.id,
      },
    }),
    prisma.device.upsert({
      where: { id: 'device-003' },
      update: { status: 'ONLINE' },
      create: {
        id: 'device-003',
        name: 'Multi Sensor Gamma',
        location: 'Warehouse A',
        type: 'MULTI_SENSOR',
        status: 'ONLINE',
        userId: user.id,
      },
    }),
    prisma.device.upsert({
      where: { id: 'device-004' },
      update: { status: 'OFFLINE' },
      create: {
        id: 'device-004',
        name: 'Noise Monitor Delta',
        location: 'Production Floor',
        type: 'NOISE',
        status: 'OFFLINE',
        userId: user.id,
      },
    }),
    prisma.device.upsert({
      where: { id: 'device-005' },
      update: { status: 'ONLINE' },
      create: {
        id: 'device-005',
        name: 'Water Quality Epsilon',
        location: 'Water Treatment Plant',
        type: 'WATER',
        status: 'ONLINE',
        userId: admin.id,
      },
    }),
  ]);

  // Generate historical sensor data (last 24 hours)
  const now = new Date();
  const dataPromises = [];

  for (const device of devices) {
    if (device.status !== 'ONLINE') continue;

    for (let i = 0; i < 288; i++) { // Every 5 minutes for 24 hours
      const timestamp = new Date(now.getTime() - i * 5 * 60 * 1000);

      let data: any = { deviceId: device.id, createdAt: timestamp };

      if (device.type === 'AIR_QUALITY') {
        data = { ...data, co2: Math.random() * 1200 + 400, pm25: Math.random() * 50 + 5, pm10: Math.random() * 100 + 10 };
      } else if (device.type === 'WEATHER') {
        data = { ...data, temperature: Math.random() * 20 + 18, humidity: Math.random() * 50 + 30 };
      } else if (device.type === 'NOISE') {
        data = { ...data, noise: Math.random() * 60 + 30, temperature: Math.random() * 15 + 20 };
      } else if (device.type === 'WATER') {
        data = { ...data, ph: Math.random() * 3 + 6.5, turbidity: Math.random() * 8, temperature: Math.random() * 20 + 10 };
      } else {
        data = {
          ...data,
          temperature: Math.random() * 20 + 18,
          humidity: Math.random() * 50 + 30,
          co2: Math.random() * 1200 + 400,
          pm25: Math.random() * 50 + 5,
          pm10: Math.random() * 100 + 10,
          noise: Math.random() * 60 + 30,
        };
      }

      dataPromises.push(prisma.sensorData.create({ data }));
    }
  }

  await Promise.all(dataPromises.slice(0, 500)); // Limit to avoid timeout

  // Create sample alerts
  await prisma.alert.createMany({
    data: [
      { message: 'CO2 levels exceeded 1000 ppm threshold', severity: 'HIGH', deviceId: 'device-001', resolved: false },
      { message: 'High temperature detected: 37.2°C', severity: 'HIGH', deviceId: 'device-003', resolved: false },
      { message: 'PM2.5 spike: 48 µg/m³', severity: 'MEDIUM', deviceId: 'device-001', resolved: true },
      { message: 'Noise level alert: 78 dB', severity: 'MEDIUM', deviceId: 'device-003', resolved: true },
    ],
    skipDuplicates: true,
  });

  console.log(`✅ Seeded successfully!`);
  console.log(`👤 Admin: admin@envirologapp.com / admin123`);
  console.log(`👤 User:  user@envirologapp.com / user123`);
  console.log(`📡 Devices: ${devices.length} created`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
