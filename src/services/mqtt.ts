/**
 * HiveMQ Cloud MQTT Service
 * ──────────────────────────────────────────────────────────────────────────────
 * Connects to HiveMQ Cloud over TLS (port 8883), subscribes to all sensor
 * topics, saves incoming readings to PostgreSQL, and broadcasts live updates
 * to connected WebSocket clients.
 *
 * The simulator runs IN PARALLEL — real device data and simulated data both
 * flow into the same database and dashboard simultaneously.
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { WebSocketServer } from 'ws';
import { prisma } from '../lib/prisma';
import { broadcast } from './websocket';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MqttConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  topicPrefix: string;
  useTls: boolean;
  clientId: string;
}

export interface MqttStatus {
  connected: boolean;
  connecting: boolean;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  messagesReceived: number;
  readingsSaved: number;
  host: string | null;
}

// ─── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  co2: { warning: 1000, critical: 2000 },
  pm25: { warning: 35, critical: 75 },
  pm10: { warning: 150, critical: 250 },
  temperature: { warning: 35, critical: 40 },
  humidity: { warning: 80, critical: 90 },
  noise: { warning: 70, critical: 85 },
};

// ─── Module state ──────────────────────────────────────────────────────────────

let client: MqttClient | null = null;
let wssRef: WebSocketServer | null = null;
let currentConfig: MqttConfig | null = null;

const status: MqttStatus = {
  connected: false,
  connecting: false,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
  messagesReceived: 0,
  readingsSaved: 0,
  host: null,
};

// Accumulate single-field messages before flushing to DB
const partialReadings: Map<string, Record<string, number | null>> = new Map();
const partialTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

// ─── Public API ────────────────────────────────────────────────────────────────

export function getMqttStatus(): MqttStatus {
  return { ...status };
}

export function getMqttConfig(): Omit<MqttConfig, 'password'> | null {
  if (!currentConfig) return null;
  const { password: _omit, ...safe } = currentConfig;
  return safe;
}

// ─── Connect / Disconnect ──────────────────────────────────────────────────────

export async function connectMqtt(config: MqttConfig, wss: WebSocketServer): Promise<void> {
  await disconnectMqtt();

  wssRef = wss;
  currentConfig = config;

  const protocol = config.useTls ? 'mqtts' : 'mqtt';
  const url = `${protocol}://${config.host}:${config.port}`;

  const options: IClientOptions = {
    clientId: config.clientId || `envirologapp-${Date.now()}`,
    username: config.username,
    password: config.password,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    keepalive: 60,
    ...(config.useTls && { rejectUnauthorized: true }),
  };

  status.connecting = true;
  status.lastError = null;
  status.host = config.host;

  console.log(`\n🐝 MQTT: Connecting to HiveMQ Cloud`);
  console.log(`   Host     : ${config.host}:${config.port}`);
  console.log(`   TLS      : ${config.useTls ? 'yes' : 'no'}`);
  console.log(`   Prefix   : ${config.topicPrefix}`);
  console.log(`   Client ID: ${options.clientId}\n`);

  client = mqtt.connect(url, options);

  client.on('connect', () => {
    status.connected = true;
    status.connecting = false;
    status.lastConnectedAt = new Date().toISOString();
    console.log(`✅ MQTT: Connected to HiveMQ Cloud (${config.host})`);

    const prefix = config.topicPrefix.replace(/\/$/, '');
    const topics = [`${prefix}/sensors/#`, `${prefix}/status/#`];

    client!.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error('MQTT: Subscription error:', err.message);
        status.lastError = err.message;
      } else {
        console.log(`📡 MQTT: Subscribed to: ${topics.join('  |  ')}`);
      }
    });

    broadcast(wss, { type: 'MQTT_STATUS', payload: getMqttStatus() });
  });

  client.on('message', (topic, message) => {
    handleMessage(topic, message.toString(), config.topicPrefix);
  });

  client.on('error', (err) => {
    status.lastError = err.message;
    status.connecting = false;
    console.error('MQTT Error:', err.message);
    if (wssRef) broadcast(wssRef, { type: 'MQTT_STATUS', payload: getMqttStatus() });
  });

  client.on('offline', () => {
    status.connected = false;
    status.lastDisconnectedAt = new Date().toISOString();
    console.warn('MQTT: Went offline');
    if (wssRef) broadcast(wssRef, { type: 'MQTT_STATUS', payload: getMqttStatus() });
  });

  client.on('reconnect', () => {
    status.connecting = true;
    console.log('MQTT: Reconnecting...');
    if (wssRef) broadcast(wssRef, { type: 'MQTT_STATUS', payload: getMqttStatus() });
  });

  client.on('close', () => {
    status.connected = false;
    status.connecting = false;
    status.lastDisconnectedAt = new Date().toISOString();
    if (wssRef) broadcast(wssRef, { type: 'MQTT_STATUS', payload: getMqttStatus() });
  });
}

export async function disconnectMqtt(): Promise<void> {
  if (client) {
    await new Promise<void>((resolve) => client!.end(true, {}, () => resolve()));
    client = null;
  }
  status.connected = false;
  status.connecting = false;
  status.lastDisconnectedAt = new Date().toISOString();
}

// ─── Publish ──────────────────────────────────────────────────────────────────

export function publishMqtt(topic: string, payload: object): boolean {
  if (!client || !status.connected) return false;
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
  return true;
}

// ─── Auto-connect from environment ────────────────────────────────────────────

export function autoConnectFromEnv(wss: WebSocketServer): void {
  const host = process.env.HIVEMQ_HOST;
  const username = process.env.HIVEMQ_USERNAME;
  const password = process.env.HIVEMQ_PASSWORD;

  if (!host || !username || !password) {
    console.log('ℹ️  HiveMQ: No credentials in .env — MQTT auto-connect skipped.');
    return;
  }

  const config: MqttConfig = {
    host,
    port: parseInt(process.env.HIVEMQ_PORT || '8883'),
    username,
    password,
    topicPrefix: process.env.HIVEMQ_TOPIC_PREFIX || 'envirologapp',
    useTls: (process.env.HIVEMQ_USE_TLS || 'true') === 'true',
    clientId: process.env.HIVEMQ_CLIENT_ID || `envirologapp-server-${Date.now()}`,
  };

  connectMqtt(config, wss).catch(err =>
    console.error('MQTT auto-connect failed:', err.message)
  );
}

// ─── Message handling ──────────────────────────────────────────────────────────

async function handleMessage(topic: string, raw: string, topicPrefix: string): Promise<void> {
  status.messagesReceived++;

  const prefix = topicPrefix.replace(/\/$/, '');

  try {
    // Status updates
    const statusMatch = topic.match(new RegExp(`^${esc(prefix)}/status/(.+)$`));
    if (statusMatch) {
      await handleStatusMessage(statusMatch[1], raw);
      return;
    }

    // Sensor data
    const sensorMatch = topic.match(new RegExp(`^${esc(prefix)}/sensors/([^/]+)(?:/(.+))?$`));
    if (!sensorMatch) return;

    const deviceId = sensorMatch[1];
    const field = sensorMatch[2];

    if (field) {
      await handleSingleField(deviceId, field, raw);
    } else {
      await handleFullPayload(deviceId, raw);
    }
  } catch (err: any) {
    console.error(`MQTT: Error on topic "${topic}":`, err.message);
  }
}

// ─── Status messages ──────────────────────────────────────────────────────────

async function handleStatusMessage(deviceId: string, raw: string): Promise<void> {
  let newStatus = 'OFFLINE';
  try {
    const parsed = JSON.parse(raw);
    newStatus = (parsed.status ?? raw).toString().toUpperCase();
  } catch {
    newStatus = raw.trim().toUpperCase();
  }
  if (!['ONLINE', 'OFFLINE', 'MAINTENANCE'].includes(newStatus)) return;

  const device = await findDevice(deviceId);
  if (!device) return;

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { status: newStatus as any },
    include: { user: { select: { id: true, email: true } } },
  });

  console.log(`📟 MQTT: [${device.name}] status → ${newStatus}`);
  if (wssRef) broadcast(wssRef, { type: 'DEVICE_STATUS', payload: updated });
}

// ─── Full JSON payload ─────────────────────────────────────────────────────────

async function handleFullPayload(deviceId: string, raw: string): Promise<void> {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn(`MQTT: Non-JSON payload from device "${deviceId}": ${raw}`);
    return;
  }
  await persistReading(deviceId, payload);
}

// ─── Single-field topic ────────────────────────────────────────────────────────

async function handleSingleField(deviceId: string, field: string, raw: string): Promise<void> {
  const VALID = ['temperature','humidity','co2','pm25','pm10','noise','ph','turbidity'];
  if (!VALID.includes(field)) return;

  const value = parseFloat(raw);
  if (isNaN(value)) return;

  if (!partialReadings.has(deviceId)) {
    partialReadings.set(deviceId, Object.fromEntries(VALID.map(f => [f, null])));
  }
  partialReadings.get(deviceId)![field] = value;

  if (partialTimers.has(deviceId)) clearTimeout(partialTimers.get(deviceId)!);
  partialTimers.set(deviceId, setTimeout(async () => {
    const snap = { ...partialReadings.get(deviceId)! };
    partialReadings.delete(deviceId);
    partialTimers.delete(deviceId);
    if (Object.values(snap).some(v => v !== null)) {
      await persistReading(deviceId, snap);
    }
  }, 2000));
}

// ─── Persist to DB ─────────────────────────────────────────────────────────────

async function persistReading(deviceId: string, payload: Record<string, any>): Promise<void> {
  const device = await findDevice(deviceId);
  if (!device) return;

  const data = {
    deviceId: device.id,
    temperature: toFloat(payload.temperature ?? payload.temp),
    humidity: toFloat(payload.humidity ?? payload.hum),
    co2: toFloat(payload.co2),
    pm25: toFloat(payload.pm25 ?? payload.pm2_5 ?? payload['pm2.5']),
    pm10: toFloat(payload.pm10),
    noise: toFloat(payload.noise ?? payload.sound ?? payload.db),
    ph: toFloat(payload.ph ?? payload.pH),
    turbidity: toFloat(payload.turbidity ?? payload.ntu),
  };

  const reading = await prisma.sensorData.create({
    data,
    include: { device: { select: { id: true, name: true, location: true } } },
  });

  status.readingsSaved++;

  if (wssRef) broadcast(wssRef, { type: 'SENSOR_DATA', payload: reading });

  if (device.status !== 'ONLINE') {
    const updated = await prisma.device.update({
      where: { id: device.id },
      data: { status: 'ONLINE' },
    });
    if (wssRef) broadcast(wssRef, { type: 'DEVICE_STATUS', payload: updated });
  }

  const { deviceId: _omit, ...numericData } = data;
  await checkThresholds(numericData, device.id);
}

// ─── Threshold alerts ─────────────────────────────────────────────────────────

async function checkThresholds(data: Record<string, number | null>, deviceId: string) {
  const alerts: { message: string; severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL' }[] = [];

  const check = (field: keyof typeof THRESHOLDS, value: number | null, unit: string) => {
    if (value === null) return;
    const t = THRESHOLDS[field];
    if (value > t.critical) {
      alerts.push({ message: `🚨 Critical ${field.toUpperCase()}: ${value} ${unit}`, severity: 'CRITICAL' });
    } else if (value > t.warning) {
      alerts.push({ message: `⚠️  High ${field.toUpperCase()}: ${value} ${unit}`, severity: 'HIGH' });
    }
  };

  check('co2', data.co2, 'ppm');
  check('pm25', data.pm25, 'µg/m³');
  check('pm10', data.pm10, 'µg/m³');
  check('temperature', data.temperature, '°C');
  check('humidity', data.humidity, '%');
  check('noise', data.noise, 'dB');

  for (const a of alerts) {
    const alert = await prisma.alert.create({
      data: { message: a.message, severity: a.severity, deviceId },
      include: { device: { select: { id: true, name: true, location: true } } },
    });
    if (wssRef) broadcast(wssRef, { type: 'ALERT', payload: alert });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findDevice(identifier: string) {
  let device = await prisma.device.findUnique({ where: { id: identifier } });
  if (!device) {
    device = await prisma.device.findFirst({
      where: { name: { equals: identifier, mode: 'insensitive' } },
    });
  }
  return device;
}

function toFloat(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(String(val));
  return isNaN(n) ? null : parseFloat(n.toFixed(4));
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}