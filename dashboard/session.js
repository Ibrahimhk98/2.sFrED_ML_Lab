export const ENV_FIELDS = ['temperature_c', 'humidity_pct', 'pressure_hpa', 'gas_ohms', 'iaq', 'voc_ppm', 'eco2_ppm', 'battery_v', 'battery_pct'];
export const IMU_FIELDS = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];
export function newSession() { return { version: 2, device: null, started: Date.now(), ended: 0, imu: [], environment: [], audio: [], bytes: 0, malformed: 0 }; }
