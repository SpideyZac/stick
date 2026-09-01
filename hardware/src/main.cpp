#include <M5Unified.h>
#include <NimBLEDevice.h>
#include <math.h>

static constexpr int SCREEN_W = 240;
static constexpr int SCREEN_H = 135;

static constexpr char DEVICE_NAME[] = "Stick";
static constexpr char SERVICE_UUID[] = "7a2fb2b0-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char AUTH_CHAR_UUID[] = "7a2fb2b1-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char STATUS_CHAR_UUID[] = "7a2fb2b2-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char DATA_CHAR_UUID[] = "7a2fb2b3-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char CONTROL_CHAR_UUID[] = "7a2fb2b4-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
static constexpr char BATTERY_CHAR_UUID[] = "7a2fb2b5-3c1a-4a9e-8f6b-1d2e3f4a5b6c";

// Pre-shared key the website must write to AUTH_CHAR to unlock the link.
// Not secret-grade, just not something you'd blindly guess.
static constexpr char SHARED_KEY[] = "SK-4Q9X-7TWZ-2LMP";
static constexpr uint32_t AUTH_TIMEOUT_MS = 60000; // disconnect if not authed in time

// Same scale factors src/imu/types.ts uses, so raw int16 counts round-trip
// through the same LSBs on both ends.
static constexpr float ACCEL_RANGE_G = 16.0f;
static constexpr float GYRO_RANGE_DPS = 2000.0f;
static constexpr float ACCEL_LSB = (ACCEL_RANGE_G * 9.80665f) / 32768.0f;
static constexpr float GYRO_LSB = (GYRO_RANGE_DPS * (float)M_PI / 180.0f) / 32768.0f;

enum class LinkState
{
    Idle,           // advertising, nobody connected
    ConnectedNoKey, // client connected, waiting for the key
    Authenticated,  // key verified
};

struct __attribute__((packed)) ImuPacket
{
    uint32_t tMs;
    int16_t ax, ay, az;
    int16_t gx, gy, gz;
};

static volatile LinkState linkState = LinkState::Idle;
static volatile uint32_t connectedAtMs = 0;
static volatile uint16_t activeConnHandle = 0;
static volatile bool disconnectPending = false; // guards against repeated disconnect() calls
static NimBLEServer *bleServer = nullptr;
static NimBLECharacteristic *statusChar = nullptr;
static NimBLECharacteristic *dataChar = nullptr;
static NimBLECharacteristic *controlChar = nullptr;
static NimBLECharacteristic *batteryChar = nullptr;

static bool recording = false;

class AuthCallbacks : public NimBLECharacteristicCallbacks
{
    void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &connInfo) override
    {
        std::string value = characteristic->getValue();
        if (value == SHARED_KEY)
        {
            linkState = LinkState::Authenticated;
            if (statusChar)
            {
                statusChar->setValue("AUTH_OK");
                statusChar->notify();
            }
            Serial.println("BLE: client authenticated");
        }
        else
        {
            Serial.println("BLE: wrong key, dropping connection");
            if (statusChar)
            {
                statusChar->setValue("AUTH_FAIL");
                statusChar->notify();
            }
            if (bleServer && !disconnectPending)
            {
                disconnectPending = true;
                bleServer->disconnect(connInfo.getConnHandle());
            }
        }
    }
};

class LinkServerCallbacks : public NimBLEServerCallbacks
{
    void onConnect(NimBLEServer *server, NimBLEConnInfo &connInfo) override
    {
        linkState = LinkState::ConnectedNoKey;
        connectedAtMs = millis();
        activeConnHandle = connInfo.getConnHandle();
        disconnectPending = false; // fresh connection, clear any stale latch
        if (statusChar)
        {
            statusChar->setValue("AUTH_REQUIRED");
            statusChar->notify();
        }
        // Ask for a short connection interval so IMU notifications can keep
        // up with the sensor; the central is free to reject/adjust this.
        server->updateConnParams(activeConnHandle, 6, 12, 0, 400);
        Serial.println("BLE: client connected, awaiting key");
    }

    void onDisconnect(NimBLEServer *server, NimBLEConnInfo &connInfo, int reason) override
    {
        linkState = LinkState::Idle;
        recording = false;
        disconnectPending = false; // clear latch so the next connection can time out cleanly
        Serial.println("BLE: client disconnected");
        server->getAdvertising()->start();
    }
};

static void bleSetup()
{
    NimBLEDevice::init(DEVICE_NAME);

    bleServer = NimBLEDevice::createServer();
    bleServer->setCallbacks(new LinkServerCallbacks());

    NimBLEService *service = bleServer->createService(SERVICE_UUID);

    NimBLECharacteristic *authChar = service->createCharacteristic(
        AUTH_CHAR_UUID, NIMBLE_PROPERTY::WRITE);
    authChar->setCallbacks(new AuthCallbacks());

    statusChar = service->createCharacteristic(
        STATUS_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    statusChar->setValue("AUTH_REQUIRED");

    dataChar = service->createCharacteristic(
        DATA_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);

    controlChar = service->createCharacteristic(
        CONTROL_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
    controlChar->setValue("REC_STOP");

    batteryChar = service->createCharacteristic(
        BATTERY_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

    NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);
    advertising->setName(DEVICE_NAME);
    advertising->start();
}

static int16_t quantize(float value, float lsb)
{
    long raw = lroundf(value / lsb);
    if (raw > 32767)
        raw = 32767;
    if (raw < -32768)
        raw = -32768;
    return (int16_t)raw;
}

static void sendImuSample(const m5::IMU_Class::imu_data_t &imu, uint32_t tMs)
{
    if (!dataChar)
        return;
    ImuPacket pkt;
    pkt.tMs = tMs;
    pkt.ax = quantize(imu.accel.x * 9.80665f, ACCEL_LSB);
    pkt.ay = quantize(imu.accel.y * 9.80665f, ACCEL_LSB);
    pkt.az = quantize(imu.accel.z * 9.80665f, ACCEL_LSB);
    pkt.gx = quantize(imu.gyro.x * (float)M_PI / 180.0f, GYRO_LSB);
    pkt.gy = quantize(imu.gyro.y * (float)M_PI / 180.0f, GYRO_LSB);
    pkt.gz = quantize(imu.gyro.z * (float)M_PI / 180.0f, GYRO_LSB);
    dataChar->setValue((uint8_t *)&pkt, sizeof(pkt));
    dataChar->notify();
}

static void setRecording(bool on)
{
    recording = on;
    if (controlChar)
    {
        controlChar->setValue(on ? "REC_START" : "REC_STOP");
        controlChar->notify();
    }
    Serial.println(on ? "Recording started (BtnA)" : "Recording stopped (BtnA)");
}

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
        return; // only show briefly right after auth
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
    if (batteryChar)
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

static void drawImuDashboard(const m5::IMU_Class::imu_data_t &imu, uint32_t nowMs)
{
    canvas.fillSprite(TFT_BLACK);

    canvas.setTextColor(TFT_WHITE, TFT_BLACK);
    canvas.setTextSize(1);
    canvas.setCursor(58, 20);
    canvas.print("IMU");

    drawLevel(imu.accel.x, imu.accel.y);
    drawGyroBar(BAR_Y0 + 0 * (BAR_H + BAR_GAP), "X", imu.gyro.x, TFT_RED);
    drawGyroBar(BAR_Y0 + 1 * (BAR_H + BAR_GAP), "Y", imu.gyro.y, TFT_GREEN);
    drawGyroBar(BAR_Y0 + 2 * (BAR_H + BAR_GAP), "Z", imu.gyro.z, TFT_CYAN);

    drawRecordingBadge();
    drawConnectedBanner(nowMs);
}

static constexpr uint32_t SPLASH_DURATION_MS = 1800;
static constexpr uint32_t DRAW_INTERVAL_MS = 40;   // ~25fps
static constexpr uint32_t SAMPLE_INTERVAL_MS = 10; // 100 Hz, matches src/imu/ble/source.ts rateHz

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

    bleSetup();
}

void loop()
{
    M5.update(); // must be called every loop to read button state
    uint32_t now = millis();

    updateBatteryReading();

    // Kick anyone who connects but never supplies the key. Latched with
    // disconnectPending so we only call disconnect() once per connection --
    // linkState only flips to Idle asynchronously once onDisconnect fires,
    // so without the latch this branch would call disconnect() on every
    // loop iteration while the teardown is still in flight, which can wedge
    // the NimBLE host/controller sync and leave the device unreachable from
    // Web Bluetooth until it's power-cycled.
    if (linkState == LinkState::ConnectedNoKey
        && !disconnectPending
        && now - connectedAtMs > AUTH_TIMEOUT_MS)
    {
        Serial.println("BLE: auth timeout, dropping connection");
        disconnectPending = true;
        if (bleServer && bleServer->getConnectedCount() > 0)
            bleServer->disconnect(activeConnHandle);
    }

    if (M5.BtnA.wasPressed())
        setRecording(!recording);

    if (M5.BtnB.wasPressed())
    {
        if (bleServer && bleServer->getConnectedCount() > 0 && !disconnectPending)
        {
            Serial.println("BtnB: disconnecting");
            disconnectPending = true;
            bleServer->disconnect(activeConnHandle);
        }
    }

    // Sample at a fixed 100 Hz to match src/imu/ble/source.ts's declared
    // rateHz. Previously this ran unthrottled (every loop iteration,
    // thousands of times a second), enqueuing BLE notifications far faster
    // than the negotiated connection interval (7.5-15ms, i.e. ~60-130/s)
    // could ever drain them. That overran NimBLE's internal mbuf pool under
    // sustained use, which is the most likely cause of the random resets --
    // and why nothing showed up in the serial monitor: a fault triggered by
    // that kind of memory pressure can take down the USB CDC stack before
    // it gets a chance to flush a crash dump.
    static uint32_t lastSampleMs = 0;
    if (linkState == LinkState::Authenticated && now - lastSampleMs >= SAMPLE_INTERVAL_MS)
    {
        lastSampleMs = now;
        M5.Imu.update();
        sendImuSample(M5.Imu.getImuData(), now - connectedAtMs);
    }

    static uint32_t lastDrawMs = 0;
    if (now - lastDrawMs >= DRAW_INTERVAL_MS)
    {
        lastDrawMs = now;

        if (now < SPLASH_DURATION_MS)
        {
            drawSplashScreen();
        }
        else if (linkState == LinkState::Authenticated)
        {
            drawImuDashboard(M5.Imu.getImuData(), now);
        }
        else
        {
            drawWaitingScreen(now);
        }

        drawBatteryBadge();
        canvas.pushSprite(0, 0);
    }

    delay(1); // yield so the idle task can feed the watchdog -- a tight loop
              // with no blocking calls starves the idle task and triggers a
              // Task Watchdog reset after ~5s
}
