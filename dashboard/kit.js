import { decodeAudio, LineParser, PROTOCOL_VERSION, protocolMismatch } from './protocol.js';
import { BlePacketParser } from './ble-protocol.js';
import { isDeviceId, kitName, validHost } from './kit-identity.js';
import { ENV_FIELDS, IMU_FIELDS } from './session.js';
import { createPublisher } from './lab/live.js';

const SERVICE = '7f510001-5b8d-4a84-9c7c-a07142ab6002';
const DATA = '7f510002-5b8d-4a84-9c7c-a07142ab6002';
const COMMAND = '7f510003-5b8d-4a84-9c7c-a07142ab6002';
const names = { usb: 'USB', bridge: 'USB bridge', ble: 'Bluetooth', ws: 'Wi-Fi' };
const el = id => document.getElementById(id);
const status = message => { el('status').textContent = message; };
let active;
const publisher = createPublisher(() => active?.identity);

function controls() {
  for (const id of ['usb', 'usbBridge', 'ble', 'wifiConnect']) el(id).disabled = !!active;
  el('disconnectBtn').disabled = !active || active.connecting;
}
function packet(channel, data) {
  if (active !== channel || channel.closing || !data) return;
  if (protocolMismatch(data)) {
    void disconnect(channel, 'This lab reads PAL protocol ' + PROTOCOL_VERSION + '. Check the kit firmware.');
    return;
  }
  if (data.device_id !== undefined && !isDeviceId(data.device_id)) return;
  if (data.device_id) {
    const previous = channel.identity;
    const name = data.device_name || (previous?.id === data.device_id && previous.name) || kitName(data.device_id);
    if (previous?.id !== data.device_id || previous.name !== name) {
      channel.identity = { id: data.device_id, name, epoch: channel.epoch, transport: names[channel.kind] };
      status(name + ' connected via ' + names[channel.kind] + '. Ready for prediction.');
    }
  }
  if (data.type === 'audio' && publisher.wants('audio')) {
    publisher.send('audio', [decodeAudio(data, channel.kind === 'bridge' ? 'usb' : channel.kind)]);
  } else if (data.type === 'environment' && Number.isFinite(data.time_ms) && publisher.wants('environment')) {
    const row = { time_ms: data.time_ms };
    for (const field of ENV_FIELDS) row[field] = data[field] == null ? NaN : Number(data[field]);
    publisher.send('environment', [row]);
  } else if (data.type === 'telemetry' && Number.isFinite(data.time_ms) && Array.isArray(data.imu) && publisher.wants('imu')) {
    const rows = [];
    for (const sample of data.imu) {
      if (!Array.isArray(sample) || sample.length !== 7 || !sample.every(Number.isFinite)) continue;
      const row = { time_ms: data.time_ms + sample[0] };
      IMU_FIELDS.forEach((field, i) => { row[field] = sample[i + 1]; });
      rows.push(row);
    }
    publisher.send('imu', rows);
  }
}

async function disconnect(channel, message = 'Disconnected.') {
  if (!channel || active !== channel || channel.closing) return;
  channel.closing = true;
  channel.identity = null;
  el('disconnectBtn').disabled = true;
  status(message);
  if (channel.reader) await channel.reader.cancel().catch(() => {});
  if (channel.readTask) await channel.readTask;
  if (channel.port?.readable) await channel.port.close().catch(() => {});
  channel.device?.gatt?.disconnect();
  channel.socket?.close();
  active = null;
  controls();
}

async function readUsb(channel) {
  const decoder = new TextDecoder();
  try {
    while (!channel.closing) {
      const { value, done } = await channel.reader.read();
      if (done) break;
      channel.parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    channel.reader.releaseLock();
  }
}
async function usb(channel) {
  if (!navigator.serial) throw new Error('USB requires a browser with Web Serial. You can also use the local USB bridge.');
  channel.port = await navigator.serial.requestPort();
  await channel.port.open({ baudRate: 230400, bufferSize: 65536 });
  channel.reader = channel.port.readable.getReader();
  channel.readTask = readUsb(channel).catch(() => {});
  channel.readTask.then(() => disconnect(channel, 'USB disconnected.'));
}

async function timed(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function bluetooth(channel) {
  if (!navigator.bluetooth) throw new Error('Choose Chrome or Edge with Web Bluetooth enabled.');
  const device = channel.device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE] }, { namePrefix: 'PAL-' }], optionalServices: [SERVICE]
  });
  device.addEventListener('gattserverdisconnected', () => disconnect(channel, 'Bluetooth disconnected.'));
  const step = promise => timed(promise, 30000, 'Bluetooth timed out. Reconnect the kit and accept pairing.');
  const server = await step(device.gatt.connect());
  const service = await step(server.getPrimaryService(SERVICE));
  const command = await step(service.getCharacteristic(COMMAND));
  await step(command.readValue());
  const stream = await step(service.getCharacteristic(DATA));
  const parser = new BlePacketParser(data => packet(channel, data));
  stream.addEventListener('characteristicvaluechanged', e => parser.push(e.target.value));
  await step(stream.startNotifications());
  // Older firmware includes its display name in the Wi-Fi status response.
  const request = new TextEncoder().encode('{"cmd":"wifi_status"}\n');
  for (let offset = 0; offset < request.length; offset += 20) {
    await step(command.writeValueWithResponse(request.slice(offset, offset + 20)));
  }
}

async function socketFeed(channel) {
  const bridge = channel.kind === 'bridge';
  const host = el('wifiHost').value.trim();
  if (!bridge && !validHost(host)) throw new Error('Enter the kit IP address or local hostname.');
  const socket = channel.socket = new WebSocket(bridge ? 'ws://127.0.0.1:8767/' : 'ws://' + host + ':81/');
  socket.onmessage = ({ data }) => { if (typeof data === 'string') channel.parser.push(data); };
  const message = bridge ? 'Start the lab USB bridge and reconnect.' : 'Check the kit address and local network access.';
  await timed(new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = socket.onclose = () => reject(new Error(message));
  }), 10000, message);
  socket.onclose = () => disconnect(channel, names[channel.kind] + ' disconnected.');
}

async function connect(kind, open) {
  if (active) return;
  const channel = active = { kind, epoch: crypto.randomUUID(), connecting: true };
  channel.parser = new LineParser(data => packet(channel, data));
  controls();
  status('Connecting via ' + names[kind] + '…');
  try {
    await open(channel);
    if (active !== channel || channel.closing) return;
    channel.connecting = false;
    if (!channel.identity) status('Connected via ' + names[kind] + '. Waiting for kit identity…');
    controls();
  } catch (error) {
    await disconnect(channel, error.message);
  }
}
el('usb').onclick = () => connect('usb', usb);
el('ble').onclick = () => connect('ble', bluetooth);
el('usbBridge').onclick = () => connect('bridge', socketFeed);
el('wifiForm').onsubmit = event => { event.preventDefault(); connect('ws', socketFeed); };
el('disconnectBtn').onclick = () => disconnect(active);
window.addEventListener('pagehide', () => disconnect(active));
