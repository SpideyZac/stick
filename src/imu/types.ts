/** One BMI270 sample. Accel in m/s^2, gyro in rad/s, time in seconds. */
export interface ImuSample {
  t: number
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
}

/**
 * The one contract between the data source and everything downstream. Samples
 * arrive in batches because that is the shape BLE notifications come in, and a
 * real BMI270 link will pack several samples per packet.
 */
export interface ImuSource {
  readonly info: { name: string; rateHz: number }
  start(): Promise<void>
  stop(): void
  onSamples(cb: (batch: ImuSample[]) => void): () => void
}

// BMI270 at the ranges the spec calls for. Quantizing the mock to these makes
// the synthetic data look like something that actually came off the chip.
export const ACCEL_RANGE_G = 16
export const GYRO_RANGE_DPS = 2000
export const ACCEL_LSB = (ACCEL_RANGE_G * 9.80665) / 32768
export const GYRO_LSB = ((GYRO_RANGE_DPS * Math.PI) / 180) / 32768

export const quantize = (value: number, lsb: number): number =>
  Math.round(value / lsb) * lsb
