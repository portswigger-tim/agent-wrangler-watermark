export const SETTINGS = [
  { key: 'disableSessionMeasurements', type: 'toggle', label: 'Disable session measurements', help: 'Stop reading same-user process metadata for card CPU and resident memory. Measurements run by default on native macOS/Linux; arguments and environments are never stored or displayed.' },
  { key: 'softPercent', type: 'number', label: 'Soft watermark (%)', min: 10, max: 95, step: 1, help: 'Warn participating sessions above this measured CPU or memory usage. Default 75; must be below the hard watermark.' },
  { key: 'hardPercent', type: 'number', label: 'Hard watermark (%)', min: 20, max: 99, step: 1, help: 'Pause admissions above this usage, including reservations. Default 90.' },
  { key: 'reserveMemoryMiB', type: 'number', label: 'Additional memory headroom (MiB)', min: 0, max: 1048576, step: 1, help: 'Memory left available in addition to the hard watermark margin. Default 512.' },
  { key: 'notifyPressure', type: 'toggle', label: 'Send pressure warnings', help: 'Mail sessions holding or waiting for resources when a watermark changes. On unless explicitly disabled.' },
];

export function config(values = {}) {
  const number = (key, fallback, min, max) => {
    const n = values[key] ?? fallback;
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid setting: ${key}`);
    return n;
  };
  const softPercent = number('softPercent', 75, 10, 95);
  const hardPercent = number('hardPercent', 90, 20, 99);
  if (softPercent >= hardPercent) throw new Error('Soft watermark must be below hard watermark.');
  return { softPercent, hardPercent, reserveMemoryMiB: number('reserveMemoryMiB', 512, 0, 1048576), notifyPressure: values.notifyPressure !== false };
}
