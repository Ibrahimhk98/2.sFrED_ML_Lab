import { IMU_FIELDS, ENV_FIELDS } from '../session.js';

export const channels = {
  audio: ['Microphone', 'full scale'],
  ax: ['Acceleration X', 'm/s²'],
  ay: ['Acceleration Y', 'm/s²'],
  az: ['Acceleration Z', 'm/s²'],
  gx: ['Gyroscope X', 'rad/s'],
  gy: ['Gyroscope Y', 'rad/s'],
  gz: ['Gyroscope Z', 'rad/s'],
  temperature_c: ['Temperature', '°C'],
  humidity_pct: ['Humidity', '%'],
  pressure_hpa: ['Pressure', 'hPa'],
  gas_ohms: ['Gas resistance', 'Ω'],
  iaq: ['Air quality estimate', 'index'],
  voc_ppm: ['VOC estimate', 'ppm'],
  eco2_ppm: ['CO₂ estimate', 'ppm'],
  battery_v: ['Battery voltage', 'V'],
  battery_pct: ['Battery charge', '%']
};
export const groups = { Microphone: ['audio'], Motion: IMU_FIELDS, Environment: ENV_FIELDS };
export const groupOf = (key) =>
  key === 'audio' ? 'audio' : IMU_FIELDS.includes(key) ? 'imu' : 'environment';
export const features = {
  mean: 'Mean',
  rms: 'Root mean square',
  sd: 'Standard deviation',
  range: 'Peak-to-peak range',
  peakHz: 'Dominant frequency',
  centroid: 'Spectral centroid',
  raw: '32 evenly spaced samples'
};
export const models = {
  knn: {
    name: 'Nearest neighbors',
    param: 'Neighbors',
    min: 1,
    max: 25,
    step: 1,
    value: 5,
    guide: 'Find windows with similar feature values. More neighbors smooth the prediction.'
  },
  ridge: {
    name: 'Ridge linear model',
    param: 'Regularization',
    min: 0.001,
    max: 100,
    step: 0.001,
    value: 1,
    guide:
      'Fit a weighted sum of features. A larger penalty shrinks the weights. Classification fits one score per class.'
  },
  tree: {
    name: 'Decision tree',
    param: 'Maximum depth',
    min: 1,
    max: 12,
    step: 1,
    value: 4,
    guide: 'Split windows using one feature at a time. A shallow tree learns fewer rules.'
  },
  forest: {
    name: 'Random forest',
    param: 'Number of trees',
    min: 3,
    max: 100,
    step: 1,
    value: 25,
    guide:
      'Average trees trained on resampled windows and random feature subsets. More trees usually give steadier predictions.'
  },
  kernel: {
    name: 'Gaussian kernel',
    param: 'Bandwidth',
    min: 0.01,
    max: 100,
    step: 0.01,
    value: 1,
    guide:
      'Nearby training windows have more influence. Increase the bandwidth to include more distant examples.'
  }
};
export const stages = {
  source: ['Import recordings', 'Give each recording the behavior or value the kit observed.'],
  scope: [
    'Signal scope',
    'Overlay the same measurement from two recordings. Choose a time interval, then switch to its spectrum to look for repeating motion or sound.'
  ],
  windows: [
    'Split & window',
    'A window is one training example. Choose a duration long enough to capture a behavior and short enough to detect a change.'
  ],
  filters: [
    'Signal filters',
    'Suppress slow drift or high-frequency noise on individual channels. Cutoffs are in hertz and must be below half the channel’s sample rate. Filters restart in each window.'
  ],
  features: [
    'Feature extraction',
    'Describe each window with the measurements you select. The model receives one row combining all selected channels.'
  ],
  plots: [
    'Feature plots',
    'Explore the values extracted from training windows. Compare their spread across behaviors, follow a feature over time, or plot two measurements against each other.'
  ],
  scale: [
    'Normalization',
    'Put features with different units on comparable scales. Fit the scaling on training windows and reuse it for validation, testing, and live predictions.'
  ],
  scores: [
    'Compare models',
    'Choose a model using validation results. Reveal held-out test scores after tuning to estimate how the selected approach performs.'
  ],
  live: [
    'Save & run live',
    'Export the trained model with its channel order, preprocessing, and class labels. Use the same pipeline to predict from a kit connected in the Live kit tab.'
  ]
};
export const defaults = () => ({
  task: 'classification',
  split: 'time',
  trainPct: 60,
  validPct: 20,
  seconds: 2,
  overlap: 50,
  channels: ['ax'],
  filters: {},
  features: ['mean', 'rms', 'sd'],
  scale: 'standard'
});
