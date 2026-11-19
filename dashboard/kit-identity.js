// device_id prints the ESP32 MAC little-endian: its last six digits are the manufacturer
// prefix shared by a whole batch, its first six the board-specific bytes (reversed).
export const isDeviceId = id => typeof id === 'string' && /^[a-f0-9]{12}$/i.test(id);
export const kitName = id => isDeviceId(id) ? `PAL-${(id.slice(4,6) + id.slice(2,4) + id.slice(0,2)).toLowerCase()}` : id;
export function validHost(host) { return typeof host === 'string' && host.length <= 253 && /^[a-zA-Z0-9.-]+$/.test(host); }
