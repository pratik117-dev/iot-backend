/**
 * HiveMQ Cloud MQTT Service — Arduino Edition
 * ─────────────────────────────────────────────────────────────────────────────
 * Connects to HiveMQ Cloud, receives Arduino sensor data, saves to PostgreSQL,
 * and pushes live updates to the dashboard via WebSocket.
 *
 * Fixes applied:
 *   1. clientId always has a random suffix → prevents HiveMQ kicking duplicate
 *      connections (which caused the connect/reconnect loop).
 *   2. reconnectPeriod = 0 → we handle reconnect manually with backoff.
 *   3. Topic prefix read from env at connect time, not hardcoded.
 *   4. Guard against double-connect calls.
 *
 * Arduino publishes to:
 *   enviraLog/node-1/data
 *   enviraLog/node-2/data
 *
 * Payload:
 *   { "device_id": "node-1", "temperature": 28.5, "humidity": 55.2,
 *     "air_quality": 95, "flame": false, "timestamp": "..." }
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { WebSocketServer } from 'ws';
import { prisma } from '../lib/prisma';
import { broadcast } from './websocket';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MqttConfig {
  host:        string;
  port:        number;
  username:    string;
  password:    string;
  topicPrefix: string;
  useTls:      boolean;
  clientId:    string;
}

export interface MqttStatus {
  connected:            boolean;
  connecting:           boolean;
  lastConnectedAt:      string | null;
  lastDisconnectedAt:   string | null;
  lastError:            string | null;
  messagesReceived:     number;
  readingsSaved:        number;
  flameAlertsTriggered: number;
  host:                 string | null;
  clientId:             string | null;
}

// ─── Thresholds ────────────────────────────────────────────────────────────────

const THRESHOLDS = {
  temperature: { warning: 60,  critical: 75  },
  humidity:    { warning: 80,  critical: 90  },
  airQuality:  { warning: 150, critical: 200 },
  co2:         { warning: 1000, critical: 2000 },
  noise:       { warning: 70,  critical: 85  },
};

// ─── Module state ──────────────────────────────────────────────────────────────

let client:        MqttClient     | null = null;
let wssRef:        WebSocketServer | null = null;
let currentConfig: MqttConfig     | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;   // guard against concurrent connect calls

const status: MqttStatus = {
  connected:            false,
  connecting:           false,
  lastConnectedAt:      null,
  lastDisconnectedAt:   null,
  lastError:            null,
  messagesReceived:     0,
  readingsSaved:        0,
  flameAlertsTriggered: 0,
  host:                 null,
  clientId:             null,
};

// ─── Public API ────────────────────────────────────────────────────────────────

export function getMqttStatus(): MqttStatus                        { return { ...status }; }
export function getMqttConfig(): Omit<MqttConfig, 'password'> | null {
  if (!currentConfig) return null;
  const { password: _p, ...safe } = currentConfig;
  return safe;
}

export async function connectMqtt(config: MqttConfig, wss: WebSocketServer): Promise<void> {
  // Guard — don't allow concurrent connect calls
  if (isConnecting) {
    console.log('MQTT: Connect already in progress, skipping duplicate call');
    return;
  }

  await disconnectMqtt();

  isConnecting   = true;
  wssRef         = wss;
  currentConfig  = config;

  const protocol = config.useTls ? 'mqtts' : 'mqtt';
  const url      = `${protocol}://${config.host}:${config.port}`;

  // ── CRITICAL FIX: always use a unique clientId ─────────────────────────────
  // HiveMQ Cloud disconnects the OLD connection when a NEW client connects with
  // the same clientId. This creates an infinite reconnect loop if two server
  // processes share the same fixed clientId (e.g. from .env).
  // Adding a random suffix makes every server instance uniquely identified.
  const baseId   = (config.clientId || 'envirologapp-server').replace(/-[a-z0-9]{6}$/, '');
  const uniqueId = `${baseId}-${Math.random().toString(36).slice(2, 8)}`;

  const options: IClientOptions = {
    clientId:           uniqueId,
    username:           config.username,
    password:           config.password,
    clean:              true,
    reconnectPeriod:    0,       // ← disable built-in auto-reconnect; we do it manually
    connectTimeout:     15000,
    keepalive:          60,
    rejectUnauthorized: false,   // HiveMQ Cloud self-signed cert OK
  };

  status.connecting = true;
  status.lastError  = null;
  status.host       = config.host;
  status.clientId   = uniqueId;

  console.log(`\n🐝 MQTT: Connecting to HiveMQ Cloud`);
  console.log(`   URL      : ${url}`);
  console.log(`   ClientID : ${uniqueId}`);
  console.log(`   Prefix   : ${config.topicPrefix}\n`);

  client = mqtt.connect(url, options);

  client.on('connect', () => {
    isConnecting               = false;
    status.connected           = true;
    status.connecting          = false;
    status.lastConnectedAt     = new Date().toISOString();
    status.lastError           = null;

    console.log(`✅ MQTT: Connected to HiveMQ Cloud`);
    console.log(`   Host  : ${config.host}`);
    console.log(`   ID    : ${uniqueId}`);

    const prefix = config.topicPrefix.replace(/\/$/, '');
    const topics = [
      `${prefix}/+/data`,     // enviraLog/node-1/data  ← your Arduino pattern
      `${prefix}/+/sensors`,  // alternative suffix
      `${prefix}/sensors/#`,  // future-proof alternate structure
      `${prefix}/status/#`,   // device online/offline
    ];

    client!.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error('MQTT: Subscribe error:', err.message);
        status.lastError = err.message;
      } else {
        console.log(`📡 MQTT: Subscribed to topics:`);
        topics.forEach(t => console.log(`         ${t}`));
      }
    });

    broadcastStatus();
  });

  client.on('message', (topic, message) => {
    handleMessage(topic, message.toString(), config.topicPrefix);
  });

  client.on('error', (err) => {
    isConnecting     = false;
    status.lastError = err.message;
    status.connecting = false;
    console.error('❌ MQTT Error:', err.message);
    broadcastStatus();
    scheduleReconnect();
  });

  client.on('close', () => {
    isConnecting               = false;
    status.connected           = false;
    status.connecting          = false;
    status.lastDisconnectedAt  = new Date().toISOString();
    broadcastStatus();
    // Only reconnect if we have a config (i.e. not a deliberate disconnect)
    if (currentConfig) scheduleReconnect();
  });

  client.on('offline', () => {
    status.connected          = false;
    status.lastDisconnectedAt = new Date().toISOString();
    console.warn('⚠️  MQTT: Client offline');
    broadcastStatus();
  });
}

export async function disconnectMqtt(): Promise<void> {
  // Cancel any pending reconnect
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  currentConfig = null;  // prevents scheduleReconnect from firing after intentional disconnect
  isConnecting  = false;

  if (client) {
    await new Promise<void>((resolve) => client!.end(true, {}, () => resolve()));
    client = null;
  }

  status.connected           = false;
  status.connecting          = false;
  status.lastDisconnectedAt  = new Date().toISOString();
}

export function publishMqtt(topic: string, payload: object): boolean {
  if (!client || !status.connected) return false;
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
  return true;
}

export function autoConnectFromEnv(wss: WebSocketServer): void {
  const host     = process.env.HIVEMQ_HOST;
  const username = process.env.HIVEMQ_USERNAME;
  const password = process.env.HIVEMQ_PASSWORD;

  if (!host || !username || !password) {
    console.log('ℹ️  HiveMQ: HIVEMQ_HOST / USERNAME / PASSWORD not set in .env');
    console.log('   MQTT auto-connect skipped — add credentials to enable.\n');
    return;
  }

  const config: MqttConfig = {
    host,
    port:        parseInt(process.env.HIVEMQ_PORT         || '8883'),
    username,
    password,
    // Default to 'enviraLog' to match your Arduino publisher
    topicPrefix: process.env.HIVEMQ_TOPIC_PREFIX          || 'enviraLog',
    useTls:     (process.env.HIVEMQ_USE_TLS               || 'true') === 'true',
    // Base clientId — a random suffix is appended inside connectMqtt()
    clientId:    process.env.HIVEMQ_CLIENT_ID              || 'envirologapp-server',
  };

  connectMqtt(config, wss).catch(err =>
    console.error('MQTT auto-connect error:', err.message)
  );
}

// ─── Manual reconnect with 5s backoff ─────────────────────────────────────────

function scheduleReconnect(): void {
  if (!currentConfig || reconnectTimer) return;
  console.log('🔄 MQTT: Will reconnect in 5s...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!currentConfig || status.connected) return;
    console.log('🔄 MQTT: Reconnecting...');
    status.connecting = true;
    broadcastStatus();
    connectMqtt(currentConfig, wssRef!).catch(err =>
      console.error('MQTT reconnect error:', err.message)
    );
  }, 5000);
}

// ─── Message router ────────────────────────────────────────────────────────────

async function handleMessage(topic: string, raw: string, topicPrefix: string): Promise<void> {
  status.messagesReceived++;

  const prefix = topicPrefix.replace(/\/$/, '');

  try {
    // enviraLog/status/<deviceId>
    const statusMatch = topic.match(new RegExp(`^${esc(prefix)}/status/(.+)$`));
    if (statusMatch) { await handleStatusMessage(statusMatch[1], raw); return; }

    // enviraLog/node-1/data   ← your exact Arduino pattern
    // enviraLog/node-1/sensors
    // enviraLog/sensors/node-1
    const arduinoMatch = topic.match(new RegExp(`^${esc(prefix)}/([^/]+)/(?:data|sensors?)$`));
    const sensorMatch  = topic.match(new RegExp(`^${esc(prefix)}/sensors/([^/]+)$`));

    const deviceIdentifier = arduinoMatch?.[1] ?? sensorMatch?.[1];
    if (!deviceIdentifier) {
      console.log(`MQTT: Unhandled topic "${topic}" — ignoring`);
      return;
    }

    await handleArduinoPayload(deviceIdentifier, raw);
  } catch (err: any) {
    console.error(`MQTT: Error on topic "${topic}":`, err.message);
  }
}

// ─── Arduino payload handler ───────────────────────────────────────────────────

async function handleArduinoPayload(topicDeviceId: string, raw: string): Promise<void> {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.warn(`MQTT: Non-JSON from "${topicDeviceId}": ${raw}`);
    return;
  }

  // Prefer device_id field inside payload, fall back to topic segment
  const rawDeviceId = String(payload.device_id ?? topicDeviceId);
  const device      = await findOrCreateDevice(rawDeviceId);

  const data: Record<string, any> = {
    deviceId:    device.id,
    rawDeviceId,
    temperature: toFloat(payload.temperature),
    humidity:    toFloat(payload.humidity),
    airQuality:  toFloat(payload.air_quality ?? payload.airQuality ?? payload.aqi),
    co2:         toFloat(payload.co2),
    pm25:        toFloat(payload.pm25 ?? payload.pm2_5),
    pm10:        toFloat(payload.pm10),
    noise:       toFloat(payload.noise ?? payload.sound),
    ph:          toFloat(payload.ph),
    turbidity:   toFloat(payload.turbidity),
    flame: payload.flame !== undefined && payload.flame !== null
      ? payload.flame === true || payload.flame === 'true' || payload.flame === 1
      : null,
  };

  const reading = await prisma.sensorData.create({
    data,
    include: { device: { select: { id: true, name: true, location: true } } },
  });

  status.readingsSaved++;

  const summary = [
    data.temperature !== null && `temp=${data.temperature}°`,
    data.humidity    !== null && `hum=${data.humidity}%`,
    data.airQuality  !== null && `aqi=${data.airQuality}`,
    data.flame       !== null && `flame=${data.flame}`,
  ].filter(Boolean).join(' | ');

  console.log(`💾 MQTT→DB [${rawDeviceId}]: ${summary}`);

  if (wssRef) broadcast(wssRef, { type: 'SENSOR_DATA', payload: reading });

  // Auto-mark ONLINE when data arrives
  if (device.status !== 'ONLINE') {
    await prisma.device.update({ where: { id: device.id }, data: { status: 'ONLINE' } });
    const updated = await prisma.device.findUnique({ where: { id: device.id } });
    if (wssRef) broadcast(wssRef, { type: 'DEVICE_STATUS', payload: updated });
  }

  await checkThresholds(data, device.id, rawDeviceId);
}

// ─── Status topic ──────────────────────────────────────────────────────────────

async function handleStatusMessage(deviceId: string, raw: string): Promise<void> {
  let newStatus = 'OFFLINE';
  try   { newStatus = (JSON.parse(raw).status ?? raw).toString().toUpperCase(); }
  catch { newStatus = raw.trim().toUpperCase(); }
  if (!['ONLINE', 'OFFLINE', 'MAINTENANCE'].includes(newStatus)) return;

  const device = await findDevice(deviceId);
  if (!device) return;

  const updated = await prisma.device.update({
    where: { id: device.id }, data: { status: newStatus as any },
  });
  if (wssRef) broadcast(wssRef, { type: 'DEVICE_STATUS', payload: updated });
}

// ─── Threshold / flame alert ───────────────────────────────────────────────────

async function checkThresholds(
  data: Record<string, any>,
  deviceId: string,
  rawDeviceId: string,
): Promise<void> {
  const alerts: { message: string; severity: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL' }[] = [];

  if (data.flame === true) {
    status.flameAlertsTriggered++;
    alerts.push({
      message:  `🔥 FLAME DETECTED by ${rawDeviceId}! Immediate action required.`,
      severity: 'CRITICAL',
    });
  }

  const check = (
    field: keyof typeof THRESHOLDS,
    value: number | null,
    unit: string,
    label: string,
  ) => {
    if (value === null) return;
    const t = THRESHOLDS[field];
    if (value > t.critical) {
      alerts.push({ message: `🚨 Critical ${label}: ${value}${unit} on ${rawDeviceId}`, severity: 'CRITICAL' });
    } else if (value > t.warning) {
      alerts.push({ message: `⚠️ High ${label}: ${value}${unit} on ${rawDeviceId}`, severity: 'HIGH' });
    }
  };

  check('temperature', data.temperature, '°',    'Temperature');
  check('humidity',    data.humidity,    '%',    'Humidity');
  check('airQuality',  data.airQuality,  ' AQI', 'Air Quality');
  check('co2',         data.co2,         ' ppm', 'CO₂');
  check('noise',       data.noise,       ' dB',  'Noise');

  for (const a of alerts) {
    const alert = await prisma.alert.create({
      data:    { message: a.message, severity: a.severity, deviceId },
      include: { device: { select: { id: true, name: true, location: true } } },
    });
    if (wssRef) broadcast(wssRef, { type: 'ALERT', payload: alert });
    console.log(`🔔 [${a.severity}] ${a.message}`);
  }
}

// ─── Device resolution / auto-create ──────────────────────────────────────────

async function findDevice(identifier: string) {
  let d = await prisma.device.findUnique({ where: { id: identifier } });
  if (d) return d;
  d = await prisma.device.findFirst({
    where: { name: { equals: identifier, mode: 'insensitive' } },
  });
  return d;
}

async function findOrCreateDevice(rawId: string) {
  const existing = await findDevice(rawId);
  if (existing) return existing;

  console.log(`📦 MQTT: Auto-creating device for "${rawId}"`);
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) throw new Error('No admin user — cannot auto-create device');

  const device = await prisma.device.create({
    data: {
      name:     rawId,
      location: 'Auto-registered (Arduino)',
      type:     'ARDUINO',
      status:   'ONLINE',
      userId:   admin.id,
    },
  });

  await prisma.systemLog.create({
    data: {
      action:  'DEVICE_AUTO_CREATED',
      userId:  admin.id,
      details: `Arduino device "${rawId}" auto-registered on first MQTT message`,
    },
  });

  if (wssRef) broadcast(wssRef, { type: 'DEVICE_STATUS', payload: device });
  console.log(`✅ Auto-created device "${rawId}" (id: ${device.id})`);
  return device;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFloat(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(String(val));
  return isNaN(n) ? null : parseFloat(n.toFixed(4));
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function broadcastStatus(): void {
  if (wssRef) broadcast(wssRef, { type: 'MQTT_STATUS', payload: getMqttStatus() });
}
