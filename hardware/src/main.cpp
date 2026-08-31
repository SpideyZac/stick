#include <M5Unified.h>

void setup()
{
    auto cfg = M5.config();
    M5.begin(cfg);

    Serial.begin(115200);
    delay(200); // let USB CDC serial settle

    M5.Display.setRotation(1);
    M5.Display.setTextSize(2);
    M5.Display.fillScreen(BLACK);
    M5.Display.setCursor(0, 0);
    M5.Display.println("Hello, StickS3!");

    Serial.println("Boot OK. PSRAM: " + String(ESP.getPsramSize()) + " bytes");
}

void loop()
{
    M5.update(); // must be called every loop to read button state

    if (M5.BtnA.wasPressed())
    {
        M5.Display.println("Button A pressed!");
        Serial.println("Button A pressed");
    }

    delay(10);
}
