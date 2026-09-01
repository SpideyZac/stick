#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <math.h>

static constexpr int SCREEN_W = 240;
static constexpr int SCREEN_H = 135;

static constexpr char DEVICE_NAME[] = "Stick";

// Protocol v2. The UUIDs moved deliberately when the pairing key came out and
// the sample stream started arriving in batches: a v1 device and a v2 site would
// otherwise find each other and then quietly disagree about the shape of every
// packet. Different UUIDs mean they simply do not see each other.
static constexpr char SERVICE_UUID[] = "7a2fb2c0-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char STATUS_CHAR_UUID[] = "7a2fb2c2-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char DATA_CHAR_UUID[] = "7a2fb2c3-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char CONTROL_CHAR_UUID[] = "7a2fb2c4-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char BATTERY_CHAR_UUID[] = "7a2fb2c5-3c1a-4a9e-8f6b-1d2e3f4a5b6c";

// ---------------------------------------------------------------------------
// Link liveness
//
// A BLE peripheral finds out about a disconnection when the controller tells it,
// and the controller only knows once the supervision timeout expires. That is
// fine for a phone walking out of range. It is no help at all for the thing that
// actually happens here: the browser tab goes to sleep, the page is closed, or
// the OS hands the GATT connection to nobody in particular. The radio link is
// still up, so this device happily believes a website is listening and keeps
// streaming into the void, and no one can connect to it because it is already
// "connected" to a tab that no longer exists.
//
// So liveness is asked at the application layer instead. The site writes PING to
// the control characteristic once a second. Miss a few in a row and the link is
// dropped from this end and advertising restarts, which is the only way the
// device can be sure someone is really there.
// ---------------------------------------------------------------------------
static constexpr uint32_t PING_TIMEOUT_MS = 4000;
/** Also drop a client that connects and then never subscribes or pings at all. */
static constexpr uint32_t HELLO_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// BMI270
//
// M5Unified brings the chip up but leaves it on its power-on defaults and scales
// readings with fixed factors that assume those defaults: 100 Hz accel at +-8 g,
// 200 Hz gyro. Neither is good enough here.
//
// +-8 g is the more serious of the two. The sensor rides on the shaft just below
// the grip, and a grip pulls six to seven g through the middle of a downswing
// from centripetal acceleration alone, before contact adds anything. At +-8 g
// full scale that clips, and a clipped accelerometer poisons the velocity
// integration the clubhead speed depends on. +-16 g leaves real headroom.
//
// 100 Hz is the other. A downswing is about a quarter of a second, so 100 Hz
// gives roughly twenty five samples to describe it, and one of those samples is
// four degrees of club rotation at speed. 400 Hz on both sensors puts that back
// to about a degree, which is the resolution the analysis actually reports at.
//
// The ranges below are chosen to match src/imu/types.ts exactly, so raw chip
// counts travel over the link untouched: no scaling here, no scaling in the
// firmware, one multiply at the far end. There is nowhere for a units mistake to
// hide.
// ---------------------------------------------------------------------------
static constexpr uint8_t BMI2_ACC_CONF = 0x40;
static constexpr uint8_t BMI2_ACC_RANGE = 0x41;
static constexpr uint8_t BMI2_GYR_CONF = 0x42;
static constexpr uint8_t BMI2_GYR_RANGE = 0x43;
static constexpr uint8_t BMI2_PWR_CONF = 0x7C;
static constexpr uint8_t BMI2_PWR_CTRL = 0x7D;

// acc_filter_perf=1, bwp=normal, odr=400 Hz
static constexpr uint8_t ACC_CONF_400HZ = 0xAA;
// acc_range = +-16 g
static constexpr uint8_t ACC_RANGE_16G = 0x03;
// filter_perf=1, noise_perf=1, bwp=normal, odr=400 Hz
static constexpr uint8_t GYR_CONF_400HZ = 0xEA;
// gyr_range = +-2000 dps, no OIS downsampling
static constexpr uint8_t GYR_RANGE_2000DPS = 0x00;
// temp | acc | gyr enabled, aux off
static constexpr uint8_t PWR_CTRL_ACC_GYR = 0x0E;
// advanced power save off; the FIFO self-wake bit stays set
static constexpr uint8_t PWR_CONF_PERF = 0x02;

// ---------------------------------------------------------------------------
// Mount
//
// There is deliberately no axis mapping here. Which way up the unit ended up on
// the shaft is worked out from an actual swing, at the far end, where the whole
// reconstruction lives (see src/swing/mount.ts): a still club at address gives
// gravity, the backswing gives the axis the club turns about, and those two pin
// the frame. So this streams the chip's own axes untouched.
//
// Which is the right division of labour anyway. The frame convention belongs to
// the pipeline that defines it, a strap that moves should not need a reflash, and
// a constant hand-entered here can be wrong in a way nothing downstream can see.
// ---------------------------------------------------------------------------

enum class LinkState
{
    Idle,      // advertising, nobody connected
    Connected, // a client is on the link
};

// ---------------------------------------------------------------------------
// Wire format
//
// One notification carries a run of samples rather than one apiece. At 400 Hz a
// sample per notification would need a packet every 2.5 ms, which is faster than
// any connection interval a browser will agree to, so the queue would simply
// grow until NimBLE ran out of buffers. Batching turns that into about 25
// notifications a second with room to spare.
//
// Timestamps are per sample rather than an assumed interval, because the sample
// that matters most is the one at contact and it should not be placed by
// arithmetic on a nominal rate.
// ---------------------------------------------------------------------------
struct __attribute__((packed)) BatchHeader
{
    uint32_t t0Ms;  // device uptime of the first sample in this batch
    uint8_t count;  // samples that follow
    uint8_t flags;  // bit 0: recording
};

struct __attribute__((packed)) SamplePacket
{
    uint16_t dtUs; // microseconds after t0Ms
    int16_t ax, ay, az;
    int16_t gx, gy, gz;
};

static constexpr size_t MAX_BATCH = 16;
static constexpr size_t GATT_OVERHEAD = 3;

static volatile LinkState linkState = LinkState::Idle;
static volatile uint32_t connectedAtMs = 0;
static volatile uint32_t lastPingMs = 0;
static volatile uint16_t activeConnHandle = 0;
static volatile bool disconnectPending = false; // guards against repeated disconnect() calls
static volatile bool streaming = false;         // client has subscribed to DATA
static volatile uint16_t peerMtu = 23;

static NimBLEServer *bleServer = nullptr;
static NimBLECharacteristic *statusChar = nullptr;
static NimBLECharacteristic *dataChar = nullptr;
static NimBLECharacteristic *controlChar = nullptr;
static NimBLECharacteristic *batteryChar = nullptr;

static bool recording = false;

static uint8_t txBuffer[sizeof(BatchHeader) + MAX_BATCH * sizeof(SamplePacket)];
static size_t batchCount = 0;
static uint32_t batchT0Ms = 0;
static int64_t batchT0Us = 0;

static uint32_t sampleCount = 0;   // samples read off the chip since boot
static uint32_t droppedCount = 0;  // samples thrown away with nowhere to send them
static float measuredHz = 0;

/** How many samples fit in one notification at the MTU the central agreed to. */
static size_t batchCapacity()
{
    if (peerMtu <= GATT_OVERHEAD + sizeof(BatchHeader) + sizeof(SamplePacket))
        return 1;
    size_t room = (peerMtu - GATT_OVERHEAD - sizeof(BatchHeader)) / sizeof(SamplePacket);
    return room > MAX_BATCH ? MAX_BATCH : room;
}

static void setStatus(const char *text)
{
    if (!statusChar)
        return;
    statusChar->setValue(text);
    statusChar->notify();
}

static void resetLink()
{
    linkState = LinkState::Idle;
    streaming = false;
    recording = false;
    disconnectPending = false;
    batchCount = 0;
    peerMtu = 23;
}

/** Hang up on the current client and get back to advertising. */
static void dropLink(const char *why)
{
    if (disconnectPending)
        return;
    Serial.printf("BLE: dropping link (%s)\n", why);
    disconnectPending = true;
    if (bleServer && bleServer->getConnectedCount() > 0)
        bleServer->disconnect(activeConnHandle);
}

class ControlCallbacks : public NimBLECharacteristicCallbacks
{
    void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo) override
    {
        std::string value = characteristic->getValue();
        // Any write at all proves someone is still on the other end; PING is
        // simply the one the site sends when it has nothing else to say.
        lastPingMs = millis();
        if (value == "REC_START")
        {
            recording = true;
        }
        else if (value == "REC_STOP")
        {
            recording = false;
        }
    }

    void onSubscribe(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo,
                     uint16_t subValue) override
    {
        lastPingMs = millis();
    }
};

class DataCallbacks : public NimBLECharacteristicCallbacks
{
    void onSubscribe(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo,
                     uint16_t subValue) override
    {
        // Nothing is streamed until someone is listening. Notifying an
        // unsubscribed client is not just wasted radio time, it is what fills
        // NimBLE's buffer pool and takes the device down.
        streaming = (subValue & 0x0001) != 0;
        lastPingMs = millis();
        Serial.println(streaming ? "BLE: client subscribed, streaming" : "BLE: client unsubscribed");
        setStatus(streaming ? "STREAMING" : "READY");
    }
};

class LinkServerCallbacks : public NimBLEServerCallbacks
{
    void onConnect(NimBLEServer *server, NimBLEConnInfo &connInfo) override
    {
        linkState = LinkState::Connected;
        connectedAtMs = millis();
        lastPingMs = connectedAtMs;
        activeConnHandle = connInfo.getConnHandle();
        disconnectPending = false;
        streaming = false;
        batchCount = 0;
        peerMtu = connInfo.getMTU();

        setStatus("READY");
        // Ask for a short connection interval so the sample stream keeps up, and a
        // supervision timeout short enough that a radio-level drop is noticed in
        // about two seconds rather than the default twenty. The central is free to
        // adjust or refuse all of it, which is exactly why the ping exists too.
        server->updateConnParams(activeConnHandle, 6, 12, 0, 200);
        Serial.println("BLE: client connected");
    }

    void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override
    {
        Serial.printf("BLE: client disconnected (reason 0x%02x)\n", reason);
        resetLink();
        // Always get back on the air. Without this the device is invisible after
        // the first client leaves, which looks exactly like a crash from the far
        // end and is the usual reason a reconnect "just fails".
        NimBLEDevice::startAdvertising();
    }

    void onMTUChange(uint16_t mtu, NimBLEConnInfo &connInfo) override
    {
        peerMtu = mtu;
        Serial.printf("BLE: MTU %u, %u samples per packet\n", mtu, (unsigned)batchCapacity());
    }
};

static void bleSetup()
{
    NimBLEDevice::init(DEVICE_NAME);
    // Ask for enough room to carry a full batch in one notification. Chrome grants
    // this; anything that does not simply gets smaller batches (see batchCapacity).
    NimBLEDevice::setMTU(247);

    bleServer = NimBLEDevice::createServer();
    bleServer->setCallbacks(new LinkServerCallbacks());

    NimBLEService *service = bleServer->createService(SERVICE_UUID);

    statusChar = service->createCharacteristic(
        STATUS_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    statusChar->setValue("IDLE");

    dataChar = service->createCharacteristic(DATA_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
    dataChar->setCallbacks(new DataCallbacks());

    controlChar = service->createCharacteristic(
        CONTROL_CHAR_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::WRITE |
            NIMBLE_PROPERTY::WRITE_NR);
    controlChar->setValue("REC_STOP");
    controlChar->setCallbacks(new ControlCallbacks());

    batteryChar = service->createCharacteristic(
        BATTERY_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

    NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);
    advertising->setName(DEVICE_NAME);
    advertising->enableScanResponse(true);
    advertising->start();
}

// ---------------------------------------------------------------------------
// IMU
// ---------------------------------------------------------------------------

static bool imuConfigured = false;

/** Put the BMI270 on the ranges and rates this app needs, not the chip defaults. */
static bool configureImu()
{
    m5::IMU_Base *chip = M5.Imu.getImuInstancePtr(0);
    if (chip == nullptr || M5.Imu.getType() != m5::imu_bmi270)
        return false;

    chip->writeRegister8(BMI2_PWR_CONF, 0x00); // power save off while we reconfigure
    delay(2);
    chip->writeRegister8(BMI2_PWR_CTRL, PWR_CTRL_ACC_GYR);
    delay(2);
    chip->writeRegister8(BMI2_ACC_CONF, ACC_CONF_400HZ);
    chip->writeRegister8(BMI2_ACC_RANGE, ACC_RANGE_16G);
    chip->writeRegister8(BMI2_GYR_CONF, GYR_CONF_400HZ);
    chip->writeRegister8(BMI2_GYR_RANGE, GYR_RANGE_2000DPS);
    delay(2);
    chip->writeRegister8(BMI2_PWR_CONF, PWR_CONF_PERF);
    delay(2);

    bool ok = chip->readRegister8(BMI2_ACC_RANGE) == ACC_RANGE_16G &&
              chip->readRegister8(BMI2_ACC_CONF) == ACC_CONF_400HZ &&
              chip->readRegister8(BMI2_GYR_CONF) == GYR_CONF_400HZ;
    Serial.println(ok ? "IMU: 400 Hz, +-16 g, +-2000 dps" : "IMU: WARNING config readback failed");

    // M5Unified seeds an offset from a single sample at boot and subtracts it from
    // everything afterwards. Whatever the club was doing at that instant is then
    // baked into every reading. The gyro bias is measured properly from the still
    // moment at address instead (src/swing/calibrate.ts), so leave the raw counts
    // alone and let the analysis do it.
    M5.Imu.setCalibration(0, 0, 0);
    M5.Imu.clearOffsetData();
    return ok;
}

/** One raw register value, straight off the chip. */
static inline int16_t rawAxis(int index)
{
    return M5.Imu.getRawData(index);
}

/**
 * Add the current reading to the batch, exactly as the chip reported it. No
 * scaling, because the chip is configured to the exact ranges src/imu/types.ts
 * assumes; and no axis mapping, because which way up the unit is strapped on is
 * worked out from a swing at the far end. Both would only be chances to get the
 * same thing wrong in a second place.
 */
static void appendSample(int64_t nowUs)
{
    if (batchCount == 0)
    {
        // Both halves of the timestamp come off the same microsecond clock. Taking
        // the millisecond part from millis() instead would let it sit up to a
        // millisecond behind the microsecond part, and that offset would be
        // different for every batch -- a whole sample period of jitter at 400 Hz,
        // manufactured out of nothing but rounding.
        batchT0Ms = (uint32_t)(nowUs / 1000);
        batchT0Us = (int64_t)batchT0Ms * 1000;
    }

    uint32_t dt = (uint32_t)(nowUs - batchT0Us);
    if (dt > 65535)
        dt = 65535;

    SamplePacket *slot =
        (SamplePacket *)(txBuffer + sizeof(BatchHeader) + batchCount * sizeof(SamplePacket));
    slot->dtUs = (uint16_t)dt;
    slot->ax = rawAxis(0);
    slot->ay = rawAxis(1);
    slot->az = rawAxis(2);
    slot->gx = rawAxis(3);
    slot->gy = rawAxis(4);
    slot->gz = rawAxis(5);
    batchCount++;
}

static void flushBatch()
{
    if (batchCount == 0 || !dataChar)
        return;
    BatchHeader *header = (BatchHeader *)txBuffer;
    header->t0Ms = batchT0Ms;
    header->count = (uint8_t)batchCount;
    header->flags = recording ? 0x01 : 0x00;

    dataChar->setValue(txBuffer, sizeof(BatchHeader) + batchCount * sizeof(SamplePacket));
    dataChar->notify();
    batchCount = 0;
}

/** Latest reading in g and dps, for the on-device screens only. */
struct Reading
{
    float ax, ay, az;
    float gx, gy, gz;
};

static Reading lastReading = {};

static void updateReading()
{
    constexpr float ACCEL_G_PER_COUNT = 16.0f / 32768.0f;
    constexpr float GYRO_DPS_PER_COUNT = 2000.0f / 32768.0f;
    lastReading.ax = rawAxis(0) * ACCEL_G_PER_COUNT;
    lastReading.ay = rawAxis(1) * ACCEL_G_PER_COUNT;
    lastReading.az = rawAxis(2) * ACCEL_G_PER_COUNT;
    lastReading.gx = rawAxis(3) * GYRO_DPS_PER_COUNT;
    lastReading.gy = rawAxis(4) * GYRO_DPS_PER_COUNT;
    lastReading.gz = rawAxis(5) * GYRO_DPS_PER_COUNT;
}

static void setRecording(bool on)
{
    recording = on;
    if (controlChar)
    {
        controlChar->setValue(on ? "REC_START" : "REC_STOP");
        controlChar->notify();
    }
    Serial.println(on ? "Recording started" : "Recording stopped");
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

static M5Canvas canvas(&M5.Display);

static float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

// Redraws the "stick" mark from public/favicon.svg (a 32x32 icon: a
// diagonal shaft, a grip wedge, and a ball) at the given center/scale.
static void drawStickMark(int cx, int cy, float scale, uint16_t shaftColor,
                           uint16_t gripColor, uint16_t ballColor)
{
    float ox = cx - 16.0f * scale;
    float oy = cy - 16.0f * scale;
    auto mapX = [&](float x) { return ox + x * scale; };
    auto mapY = [&](float y) { return oy + y * scale; };

    // Shaft: thick rounded line from (20,7) to (12,22).
    float x0 = mapX(20), y0 = mapY(7), x1 = mapX(12), y1 = mapY(22);
    float halfW = 2.2f * scale / 2.0f;
    float dx = x1 - x0, dy = y1 - y0;
    float len = sqrtf(dx * dx + dy * dy);
    float nx = -dy / len * halfW, ny = dx / len * halfW;
    canvas.fillTriangle(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, shaftColor);
    canvas.fillTriangle(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, shaftColor);
    canvas.fillCircle((int)x0, (int)y0, (int)halfW, shaftColor);
    canvas.fillCircle((int)x1, (int)y1, (int)halfW, shaftColor);

    // Grip wedge: triangle (12,22) (8,24) (9,20).
    canvas.fillTriangle(mapX(12), mapY(22), mapX(8), mapY(24), mapX(9), mapY(20), gripColor);

    // Ball: circle at (22,25) r2.6.
    canvas.fillCircle((int)mapX(22), (int)mapY(25), (int)(2.6f * scale), ballColor);
}

static void drawSplashScreen()
{
    canvas.fillSprite(TFT_BLACK);
    drawStickMark(SCREEN_W / 2, 46, 3.0f, TFT_LIGHTGREY, TFT_GREEN, TFT_WHITE);

    canvas.setTextDatum(middle_center);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(3);
    canvas.drawString("Stick", SCREEN_W / 2, 106);
    canvas.setTextDatum(top_left);
}

static void drawWaitingScreen(uint32_t nowMs)
{
    canvas.fillSprite(TFT_BLACK);

    drawStickMark(30, 26, 1.1f, TFT_LIGHTGREY, TFT_GREEN, TFT_WHITE);
    canvas.setTextDatum(middle_left);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(2);
    canvas.drawString("Stick", 52, 26);
    canvas.setTextDatum(top_left);

    // Radar-style pulsing rings to show it's actively searching.
    int cx = SCREEN_W / 2, cy = 82;
    for (int i = 0; i < 3; ++i)
    {
        uint32_t phase = (nowMs / 20 + i * 500) % 1500;
        float r = 4.0f + (phase / 1500.0f) * 34.0f;
        uint8_t alpha = 255 - (uint8_t)(phase / 1500.0f * 255);
        uint16_t ringColor = canvas.color565(0, alpha / 2, 0);
        canvas.drawCircle(cx, cy, (int)r, ringColor);
    }
    canvas.fillCircle(cx, cy, 4, TFT_GREEN);

    int dots = (nowMs / 400) % 4;
    String msg = "Waiting for connection";
    for (int i = 0; i < dots; ++i)
        msg += ".";

    canvas.setTextDatum(middle_center);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.drawString(msg, SCREEN_W / 2, 122);
    canvas.setTextDatum(top_left);
}

static void drawConnectedBanner(uint32_t nowMs)
{
    if (nowMs > connectedAtMs + 1200)
        return; // only show briefly right after connecting
    canvas.fillRect(0, 0, SCREEN_W, 16, TFT_DARKGREEN);
    canvas.setTextDatum(middle_center);
    canvas.setTextColor(TFT_WHITE, TFT_DARKGREEN);
    canvas.setTextSize(1);
    canvas.drawString("CONNECTED", SCREEN_W / 2, 8);
    canvas.setTextDatum(top_left);
}

static void drawRecordingBadge()
{
    if (!recording)
        return;
    bool blink = (millis() / 500) % 2 == 0;
    if (blink)
        canvas.fillCircle(10, 20, 4, TFT_RED);
    canvas.setTextColor(TFT_RED, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(18, 16);
    canvas.print("REC");
}

// Always-on battery readout, top-right corner of every screen.
static int batteryPct = -1;
static bool batteryCharging = false;

static void updateBatteryReading()
{
    static uint32_t lastMs = 0;
    uint32_t now = millis();
    if (now - lastMs < 3000 && lastMs != 0)
        return;
    lastMs = now;
    batteryPct = M5.Power.getBatteryLevel();
    batteryCharging = M5.Power.isCharging() == m5::Power_Class::is_charging;
    if (batteryChar && linkState == LinkState::Connected)
    {
        uint8_t v = (uint8_t)clampf((float)batteryPct, 0, 100);
        batteryChar->setValue(&v, 1);
        batteryChar->notify();
    }
}

static void drawBatteryBadge()
{
    const int w = 22, h = 11;
    const int x = SCREEN_W - w - 3, y = 3;

    canvas.drawRect(x, y, w, h, TFT_WHITE);
    canvas.fillRect(x + w, y + 3, 2, h - 6, TFT_WHITE);

    if (batteryPct >= 0)
    {
        int fillW = (int)((w - 4) * clampf(batteryPct / 100.0f, 0.0f, 1.0f));
        uint16_t fillColor = batteryPct < 20 ? TFT_RED : (batteryPct < 40 ? TFT_YELLOW : TFT_GREEN);
        canvas.fillRect(x + 2, y + 2, fillW, h - 4, fillColor);
    }

    canvas.setTextDatum(middle_right);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(1);
    char buf[8];
    if (batteryPct >= 0)
        snprintf(buf, sizeof(buf), "%s%d%%", batteryCharging ? "+" : "", batteryPct);
    else
        snprintf(buf, sizeof(buf), "--");
    canvas.drawString(buf, x - 4, y + h / 2);
    canvas.setTextDatum(top_left);
}

static constexpr int LEVEL_CX = 62;
static constexpr int LEVEL_CY = 74;
static constexpr int LEVEL_R = 50;

static constexpr int BAR_X = 132;
static constexpr int BAR_W = 96;
static constexpr int BAR_H = 20;
static constexpr int BAR_GAP = 8;
static constexpr int BAR_Y0 = 24;
static constexpr float GYRO_MAX_DPS = 500.0f;

static void drawLevel(float accelX, float accelY)
{
    canvas.drawCircle(LEVEL_CX, LEVEL_CY, LEVEL_R, TFT_DARKGREY);
    canvas.drawCircle(LEVEL_CX, LEVEL_CY, LEVEL_R * 2 / 3, TFT_DARKGREY);
    canvas.drawCircle(LEVEL_CX, LEVEL_CY, LEVEL_R / 3, TFT_DARKGREY);
    canvas.drawLine(LEVEL_CX - LEVEL_R, LEVEL_CY, LEVEL_CX + LEVEL_R, LEVEL_CY, TFT_DARKGREY);
    canvas.drawLine(LEVEL_CX, LEVEL_CY - LEVEL_R, LEVEL_CX, LEVEL_CY + LEVEL_R, TFT_DARKGREY);

    float dx = clampf(accelX, -1.0f, 1.0f) * LEVEL_R;
    float dy = clampf(-accelY, -1.0f, 1.0f) * LEVEL_R;
    float mag = sqrtf(dx * dx + dy * dy);
    if (mag > LEVEL_R)
    {
        dx = dx * LEVEL_R / mag;
        dy = dy * LEVEL_R / mag;
    }

    float tilt = sqrtf(accelX * accelX + accelY * accelY);
    uint16_t bubbleColor = tilt < 0.05f ? TFT_GREEN : (tilt < 0.2f ? TFT_YELLOW : TFT_RED);

    int bx = LEVEL_CX + (int)dx;
    int by = LEVEL_CY + (int)dy;
    canvas.fillCircle(bx, by, 7, bubbleColor);
    canvas.drawCircle(bx, by, 7, TFT_WHITE);

    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(LEVEL_CX - 18, LEVEL_CY + LEVEL_R + 6);
    canvas.print("LEVEL");
}

static void drawGyroBar(int y, const char *label, float dps, uint16_t color)
{
    int cx = BAR_X + BAR_W / 2;

    canvas.drawRect(BAR_X, y, BAR_W, BAR_H, TFT_DARKGREY);
    canvas.drawLine(cx, y, cx, y + BAR_H, TFT_DARKGREY);

    float frac = clampf(dps / GYRO_MAX_DPS, -1.0f, 1.0f);
    int fillW = (int)(frac * (BAR_W / 2 - 2));
    if (fillW >= 0)
        canvas.fillRect(cx, y + 2, fillW, BAR_H - 4, color);
    else
        canvas.fillRect(cx + fillW, y + 2, -fillW, BAR_H - 4, color);

    canvas.setTextColor(color, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(BAR_X - 14, y + 6);
    canvas.print(label);

    char buf[16];
    snprintf(buf, sizeof(buf), "%4.0f", dps);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setCursor(BAR_X + BAR_W + 4, y + 6);
    canvas.print(buf);
}

static void drawImuDashboard(uint32_t nowMs)
{
    canvas.fillSprite(TFT_BLACK);

    canvas.setTextColor(streaming ? TFT_GREEN : TFT_YELLOW, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(46, 20);
    canvas.printf("%3.0fHz", measuredHz);

    drawLevel(lastReading.ax, lastReading.ay);
    drawGyroBar(BAR_Y0 + 0 * (BAR_H + BAR_GAP), "X", lastReading.gx, TFT_RED);
    drawGyroBar(BAR_Y0 + 1 * (BAR_H + BAR_GAP), "Y", lastReading.gy, TFT_GREEN);
    drawGyroBar(BAR_Y0 + 2 * (BAR_H + BAR_GAP), "Z", lastReading.gz, TFT_CYAN);

    drawRecordingBadge();
    drawConnectedBanner(nowMs);
}

/**
 * Raw sensor readout, for checking the hardware rather than the golf.
 *
 * It deliberately passes no judgement on how the unit is strapped on: that is not
 * something this end knows any more, and guessing at it here is what produced a
 * confidently wrong answer before. What it can say is whether the chip is alive,
 * reading one g when it is sitting still, and delivering samples at the rate it
 * was configured for.
 */
static void drawRawScreen()
{
    canvas.fillSprite(TFT_BLACK);
    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(6, 20);
    canvas.print("RAW SENSOR");

    float g = sqrtf(lastReading.ax * lastReading.ax + lastReading.ay * lastReading.ay +
                    lastReading.az * lastReading.az);

    canvas.setCursor(6, 38);
    canvas.printf("accel  x %+5.2f  y %+5.2f  z %+5.2f", lastReading.ax, lastReading.ay,
                  lastReading.az);
    canvas.setCursor(6, 52);
    canvas.printf("gyro  x %+6.0f y %+6.0f z %+6.0f", lastReading.gx, lastReading.gy,
                  lastReading.gz);

    // A still unit has to read one g. Anything else means the range is not what the
    // far end assumes, and every number downstream is scaled wrong.
    bool restingRight = fabsf(g - 1.0f) < 0.15f;
    canvas.setTextColor(restingRight ? TFT_GREEN : TFT_RED, TFT_BLACK);
    canvas.setTextSize(2);
    canvas.setCursor(6, 72);
    canvas.printf("%4.2f g", g);

    canvas.setTextSize(1);
    canvas.setTextColor(measuredHz > 350 ? TFT_GREEN : TFT_RED, TFT_BLACK);
    canvas.setCursor(96, 78);
    canvas.printf("%3.0f Hz", measuredHz);

    canvas.setTextColor(TFT_DARKGREY, TFT_BLACK);
    canvas.setCursor(6, 102);
    canvas.print(restingRight ? "Hold still: should read 1.00 g." : "Not 1 g. Hold still, or IMU is off.");
    canvas.setCursor(6, 118);
    canvas.printf("pkts %lu  dropped %lu  mtu %u", (unsigned long)sampleCount,
                  (unsigned long)droppedCount, peerMtu);
}

// ---------------------------------------------------------------------------

static constexpr uint32_t SPLASH_DURATION_MS = 1800;
static constexpr uint32_t DRAW_INTERVAL_MS = 40; // ~25fps

static bool rawScreen = false;

void setup()
{
    auto cfg = M5.config();
    M5.begin(cfg);

    Serial.begin(115200);
    delay(200); // let USB CDC serial settle

    M5.Display.setRotation(1);
    M5.Display.fillScreen(TFT_BLACK);

    canvas.setColorDepth(8);
    canvas.createSprite(SCREEN_W, SCREEN_H);

    Serial.println("Boot OK. PSRAM: " + String(ESP.getPsramSize()) + " bytes");
    if (!M5.Imu.isEnabled())
    {
        Serial.println("WARNING: no IMU detected on this unit");
    }
    else
    {
        M5.Imu.setClock(400000);
        // Stream either way. A failed readback means the ranges may not be what the
        // far end assumes, which is worth shouting about in the log, but a stream
        // on the wrong scale still beats no stream at all while it is diagnosed.
        configureImu();
        imuConfigured = true;
    }

    bleSetup();
}

void loop()
{
    M5.update(); // must be called every loop to read button state
    uint32_t now = millis();

    updateBatteryReading();

    if (linkState == LinkState::Connected && !disconnectPending)
    {
        // Nothing has been heard from the far end for a while. On a healthy link
        // the site pings once a second, so this means the tab is gone, asleep, or
        // wedged -- and the only way back to a device anyone can connect to is to
        // hang up and advertise again.
        if (now - lastPingMs > PING_TIMEOUT_MS)
        {
            dropLink("no ping");
        }
        else if (!streaming && now - connectedAtMs > HELLO_TIMEOUT_MS)
        {
            dropLink("never subscribed");
        }
    }

    if (M5.BtnA.wasPressed())
        setRecording(!recording);

    if (M5.BtnB.wasPressed())
        rawScreen = !rawScreen;

    // Take everything the chip has. At 400 Hz new data lands every 2.5ms and this
    // loop runs far quicker than that, so update() mostly returns nothing and the
    // reads stay in step with the sensor rather than with the loop.
    //
    // Paced off the gyro flag specifically. Accel and gyro run at the same rate and
    // arrive in the same burst read, but they carry their own data-ready bits, and
    // taking either one would now and then split a single period into two samples.
    if (imuConfigured && (M5.Imu.update() & m5::IMU_Class::sensor_mask_gyro))
    {
        int64_t nowUs = esp_timer_get_time();
        sampleCount++;
        updateReading();

        if (streaming)
        {
            appendSample(nowUs);
            if (batchCount >= batchCapacity())
                flushBatch();
        }
        else if (batchCount > 0)
        {
            droppedCount += batchCount;
            batchCount = 0;
        }
    }

    // Don't let a partly filled batch sit around if the sample rate dips.
    static uint32_t lastFlushMs = 0;
    if (batchCount > 0 && now - lastFlushMs >= 20)
    {
        lastFlushMs = now;
        flushBatch();
    }

    static uint32_t rateWindowMs = 0;
    static uint32_t rateWindowCount = 0;
    if (now - rateWindowMs >= 1000)
    {
        measuredHz = (sampleCount - rateWindowCount) * 1000.0f / (float)(now - rateWindowMs);
        rateWindowMs = now;
        rateWindowCount = sampleCount;
    }

    static uint32_t lastDrawMs = 0;
    if (now - lastDrawMs >= DRAW_INTERVAL_MS)
    {
        lastDrawMs = now;

        if (now < SPLASH_DURATION_MS)
        {
            drawSplashScreen();
        }
        else if (rawScreen)
        {
            drawRawScreen();
        }
        else if (linkState == LinkState::Connected)
        {
            drawImuDashboard(now);
        }
        else
        {
            drawWaitingScreen(now);
        }

        drawBatteryBadge();
        canvas.pushSprite(0, 0);
    }

    // The idle task has to run or the Task Watchdog resets the chip after about
    // five seconds, but delay(1) on every pass would mean polling the sensor only
    // once per millisecond -- nearly half a sample period at 400 Hz, which shows
    // up as jitter on every timestamp the analysis integrates over. So it busy
    // waits between polls and gives the scheduler a proper turn a few hundred
    // times a second, which is far more than the watchdog needs.
    static uint32_t lastYieldMs = 0;
    if (now - lastYieldMs >= 4)
    {
        lastYieldMs = now;
        delay(1);
    }
    else
    {
        delayMicroseconds(250);
    }
}
