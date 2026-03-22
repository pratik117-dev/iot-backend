import { WebSocketServer } from 'ws';
import { prisma } from '../lib/prisma';
import { broadcast } from './websocket';

const THRESHOLDS = {
  co2: { warning: 1000, critical: 2000 },
  pm25: { warning: 35, critical: 75 },
  pm10: { warning: 150, critical: 250 },
  temperature: { warning: 35, critical: 40 },
  humidity: { warning: 80, critical: 90 },
  noise: { warning: 70, critical: 85 },
};

function randomBetween(min: number, max: number, decimals = 1): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function addVariation(base: number, variance: number): number {
  return parseFloat((base + (Math.random() - 0.5) * variance * 2).toFixed(1));
}

// Simulate realistic sensor data
function generateSensorData(deviceType: string) {
  const baseValues: Record<string, any> = {
    AIR_QUALITY: {
      co2: randomBetween(400, 1500),
      pm25: randomBetween(5, 60),
      pm10: randomBetween(10, 120),
      noise: null,
      ph: null,
      turbidity: null,
    },
    WEATHER: {
      temperature: randomBetween(18, 38),
      humidity: randomBetween(30, 95),
      co2: null,
      pm25: null,
      noise: null,
      ph: null,
      turbidity: null,
    },
    NOISE: {
      noise: randomBetween(30, 90),
      temperature: randomBetween(18, 35),
      humidity: randomBetween(30, 85),
      co2: null,
      pm25: null,
      ph: null,
      turbidity: null,
    },
    WATER: {
      ph: randomBetween(5.5, 9.5, 2),
      turbidity: randomBetween(0, 15, 2),
      temperature: randomBetween(10, 30),
      co2: null,
      pm25: null,
      noise: null,
    },
    MULTI_SENSOR: {
      temperature: randomBetween(18, 38),
      humidity: randomBetween(30, 95),
      co2: randomBetween(400, 1800),
      pm25: randomBetween(5, 80),
      pm10: randomBetween(10, 150),
      noise: randomBetween(30, 90),
      ph: null,
      turbidity: null,
    },
  };

  return baseValues[deviceType] || baseValues.MULTI_SENSOR;
}

async function checkThresholds(data: any, deviceId: string, wss: WebSocketServer) {
  const alerts: Array<{ message: string; severity: string }> = [];

  if (data.co2 !== null && data.co2 > THRESHOLDS.co2.critical) {
    alerts.push({ message: `Critical CO2 level: ${data.co2} ppm (threshold: ${THRESHOLDS.co2.critical})`, severity: 'CRITICAL' });
  } else if (data.co2 !== null && data.co2 > THRESHOLDS.co2.warning) {
    alerts.push({ message: `High CO2 level: ${data.co2} ppm (threshold: ${THRESHOLDS.co2.warning})`, severity: 'HIGH' });
  }

  if (data.pm25 !== null && data.pm25 > THRESHOLDS.pm25.critical) {
    alerts.push({ message: `Critical PM2.5 level: ${data.pm25} µg/m³`, severity: 'CRITICAL' });
  } else if (data.pm25 !== null && data.pm25 > THRESHOLDS.pm25.warning) {
    alerts.push({ message: `Elevated PM2.5: ${data.pm25} µg/m³`, severity: 'MEDIUM' });
  }

  if (data.temperature !== null && data.temperature > THRESHOLDS.temperature.critical) {
    alerts.push({ message: `Critical temperature: ${data.temperature}°C`, severity: 'CRITICAL' });
  } else if (data.temperature !== null && data.temperature > THRESHOLDS.temperature.warning) {
    alerts.push({ message: `High temperature: ${data.temperature}°C`, severity: 'HIGH' });
  }

  if (data.noise !== null && data.noise > THRESHOLDS.noise.critical) {
    alerts.push({ message: `Dangerous noise level: ${data.noise} dB`, severity: 'CRITICAL' });
  } else if (data.noise !== null && data.noise > THRESHOLDS.noise.warning) {
    alerts.push({ message: `High noise level: ${data.noise} dB`, severity: 'MEDIUM' });
  }

  for (const alertData of alerts) {
    const alert = await prisma.alert.create({
      data: {
        message: alertData.message,
        severity: alertData.severity as any,
        deviceId,
      },
      include: { device: { select: { id: true, name: true, location: true } } },
    });

    broadcast(wss, { type: 'ALERT', payload: alert });
  }
}

export async function startSensorSimulation(wss: WebSocketServer) {
  console.log('🔄 Starting IoT sensor simulation...');

  const simulate = async () => {
    try {
      const devices = await prisma.device.findMany({
        where: { status: 'ONLINE' },
        select: { id: true, type: true },
      });

      if (devices.length === 0) return;

      for (const device of devices) {
        const sensorValues = generateSensorData(device.type);

        const reading = await prisma.sensorData.create({
          data: { deviceId: device.id, ...sensorValues },
          include: { device: { select: { id: true, name: true, location: true } } },
        });

        broadcast(wss, { type: 'SENSOR_DATA', payload: reading });

        // Check thresholds (only sometimes to avoid alert spam)
        if (Math.random() < 0.1) {
          await checkThresholds(sensorValues, device.id, wss);
        }
      }
    } catch (err) {
      // Database might not be ready yet
    }
  };

  // Run every 5 seconds
  setInterval(simulate, 5000);

  // Initial run after 3 seconds
  setTimeout(simulate, 3000);
}
