# Stick

Turns motion data from a sensor on the grip of a golf club into swing stats, a 3D
swing replay, and an estimated ball flight. Runs in a phone browser.

There's no hardware yet, so everything runs against a mock swing generator. A real
BLE sensor can drop in later behind the same interface without touching anything
downstream.

## Running it

```
npm install
npm run dev -- --host    # open the LAN address on your phone
npm test
npm run build
```

## Layout

| Area                          | Where              |
| ----------------------------- | ------------------ |
| IMU source interface          | `src/imu/types.ts` |
| Mock sensor and canned swings | `src/imu/mock/`    |
| Swing detection and analysis  | `src/swing/`       |
| Ball flight estimate          | `src/flight/`      |
| 3D replay                     | `src/three/`       |
| UI                            | `src/ui/`          |

## Notes

- No driver support yet. It's the one club that's teed up rather than grounded, and
  the address calibration assumes the club is resting on the ground.
- The hands are modelled as their own moving part rather than a fixed pivot, since
  that's where a real chunk of clubhead speed comes from.
- Yaw drifts a little over time since there's no magnetometer, so every angle is
  measured relative to address rather than to true north.

`npm test` covers the full chain, including a round trip check where the mock
generator's known swing gets fed through detection and analysis and compared
against what it should recover.
