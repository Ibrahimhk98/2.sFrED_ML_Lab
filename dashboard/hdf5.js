import { ENV_FIELDS, IMU_FIELDS, newSession } from './session.js';
const AUDIO_FIELDS = ['time_ms', 'rate', 'sequence', 'stream_id', 'segment', 'sample_index', 'monotonic_us', 'dbfs', 'dropped', 'overruns', 'clock_synced'];
const TRANSPORTS = ['usb', 'ble', 'ws'];
const CODECS = ['pcm_s16le', 'ima_adpcm'];
export function readSession(h5, FS, bytes) {
  const path = 'import.h5'; let file;
  try {
    FS.writeFile(path, bytes); file = new h5.File(path, 'r');
    if (file.attrs.schema?.value !== 'pal-v2-timeseries' || Number(file.attrs.schema_version?.value) !== 2)
      throw new Error('Use a PAL time-series HDF5 recording (schema version 2)');
    const session = newSession();
    if(file.attrs.device_id?.value) session.device = {id:file.attrs.device_id.value,name:file.attrs.device_name?.value || file.attrs.device_id.value};
    // Files exported before firmware stamping have no firmware attributes.
    if(session.device && file.attrs.firmware_version?.value) Object.assign(session.device, {firmware:file.attrs.firmware_version.value, firmwareBuilt:file.attrs.firmware_built?.value || ''});
    session.started = Number(file.attrs.started_ms.value); session.ended = Number(file.attrs.ended_ms.value);
    session.malformed = Number(file.attrs.malformed_packets?.value || 0);
    // Bound decompressed data before asking WASM to allocate it.
    let size = 0;
    for (const path of file.paths()) {
      const ds = file.get(path);
      if (ds.shape) size += ds.shape.reduce((a,b) => a*b, 1) * 8;
    }
    if (size > 512 * 1024 * 1024) throw new Error('Recording is too large for the behavior lab');
    for (const [name, fields] of [['imu', IMU_FIELDS], ['environment', ENV_FIELDS]]) {
      const t = file.get(`${name}/time_ms`).value, values = file.get(`${name}/values`).value;
      if (values.length !== t.length * fields.length || !Array.from(t).every(Number.isFinite)) throw new Error('Invalid sensor array dimensions');
      session[name] = Array.from(t, (time_ms, i) => Object.fromEntries([['time_ms', time_ms], ...fields.map((f, j) => [f, values[i * fields.length + j]])]));
    }
    const pcm = file.get('audio/pcm_s16').value, offsets = file.get('audio/frame_offsets').value;
    const meta = Object.fromEntries([...AUDIO_FIELDS, 'transport', 'codec'].map(f => [f, file.get(`audio/${f}`).value]));
    const count = meta.time_ms.length;
    if (!(pcm instanceof Int16Array) || offsets.length !== count + 1 || offsets[0] !== 0 || offsets[count] !== pcm.length || Object.values(meta).some(a => a.length !== count))
      throw new Error('Invalid audio frame index');
    for (let i = 0; i < count; i++) {
      if (!Number.isInteger(offsets[i]) || offsets[i + 1] <= offsets[i] || offsets[i + 1] > pcm.length || !Number.isFinite(meta.time_ms[i]) || !Number.isInteger(meta.rate[i]) || meta.rate[i] < 8000 || meta.rate[i] > 48000)
        throw new Error('Invalid audio frame metadata');
      session.audio.push({...Object.fromEntries(AUDIO_FIELDS.map(f => [f, meta[f][i]])), pcm: pcm.subarray(offsets[i], offsets[i + 1]), transport:TRANSPORTS[meta.transport[i]], codec:CODECS[meta.codec[i]]});
    }
    session.bytes = pcm.byteLength + session.imu.length * 64 + session.environment.length * 96;
    return session;
  } finally { if (file) file.close(); try { FS.unlink(path); } catch {} }
}
