#include <Arduino.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

/* ===== GPIO (UNCHANGED) ===== */
#define BUZZER_PIN   4
#define GREEN_LED    5
#define RED_LED      6
#define RELAY_PIN    7

#define SS_PIN 10
#define RST_PIN 8

MFRC522 mfrc522(SS_PIN, RST_PIN);

/* ===== WIFI (UNCHANGED) ===== */
const char* WIFI_SSID = "Wi-Fi";
const char* WIFI_PASS = "otmane24";

/* ===== BACKEND ===== */
const char* API_BASE = "http://192.168.43.73:3000";

const char* DEVICE_ID = "door_01";

/* ===== STATE ===== */
bool lockdown = false;
bool actionActive = false;
unsigned long actionStart = 0;

/* ===== COMMAND POLLING ===== */
unsigned long lastCmdCheck = 0;
const unsigned long CMD_INTERVAL = 1500; // 1.5s

/* ===== DOOR STATE ===== */
String doorStatus = "CLOSED";   // CLOSED | OPEN | LOCKDOWN
unsigned long doorTimer = 0;

/* ===== AUTHORIZED CARDS ===== */
String authorizedCards[] = {
  "6C9FAD89",   // ✅ YOUR REAL CARD
  "11223344"
};

/* ===== WIFI ===== */
void setupWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting WiFi");
  unsigned long t0 = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi failed");
  }
}

void ensureWifi() {
  if (WiFi.status() != WL_CONNECTED) {
    setupWifi();
  }
}

/* ===== BUZZER ===== */
void beepGranted() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(150);
  digitalWrite(BUZZER_PIN, LOW);
}

void beepDenied() {
  for (int i = 0; i < 2; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(300);
    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}

void buzzerTest() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(200);
    digitalWrite(BUZZER_PIN, LOW);
    delay(200);
  }
}

/* ===== BACKEND: SEND ACCESS EVENT ===== */
void sendAccessEvent(const String& uid, const String& status) {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(API_BASE) + "/api/access");
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<200> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["uid"] = uid;
  doc["status"] = status;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.print("Access POST -> ");
  Serial.println(code);

  http.end();
}

/* ===== HEARTBEAT (with debug) ===== */
void sendHeartbeat() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(String(API_BASE) + "/api/heartbeat");
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<128> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["doorStatus"] = doorStatus;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.print("Heartbeat POST -> ");
  Serial.print(code);
  Serial.print("  doorStatus=");
  Serial.println(doorStatus);

  http.end();
}

/* ===== BACKEND: POLL COMMAND ===== */
void checkCommand() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(API_BASE) + "/api/control/pending?deviceId=" + DEVICE_ID;
  http.begin(url);

  int code = http.GET();
  if (code != 200) {
    http.end();
    return;
  }

  StaticJsonDocument<200> doc;
  deserializeJson(doc, http.getString());
  http.end();

  if (doc["cmd"].isNull()) return;

  String cmd = doc["cmd"];
  Serial.print("CMD received: ");
  Serial.println(cmd);

  if (cmd == "open") {
    // ===== OPEN DOOR FROM DASHBOARD =====
    doorStatus = "OPEN";
    doorTimer = millis();
    sendHeartbeat(); // ✅ tell backend instantly

    // Green LED animation (unchanged)
    for (int i = 0; i < 4; i++) {
      digitalWrite(GREEN_LED, HIGH);
      delay(200);
      digitalWrite(GREEN_LED, LOW);
      delay(200);
    }

    beepGranted();

    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RELAY_PIN, HIGH);

    // use same auto-reset system as RFID
    actionStart = millis();
    actionActive = true;
  }
  else if (cmd == "buzzer_test") {
    buzzerTest();
  }
  else if (cmd == "lockdown_on") {
    lockdown = true;
    doorStatus = "LOCKDOWN";
    sendHeartbeat();
    Serial.println("LOCKDOWN ENABLED");
  }
  else if (cmd == "lockdown_off") {
    lockdown = false;
    doorStatus = "CLOSED";
    sendHeartbeat();
    Serial.println("LOCKDOWN DISABLED");
  }
}

/* ===== AUTH CHECK ===== */
bool isAuthorized(const String& uid) {
  for (int i = 0; i < (int)(sizeof(authorizedCards) / sizeof(authorizedCards[0])); i++) {
    if (uid.equals(authorizedCards[i])) return true;
  }
  return false;
}

/* ===== SETUP ===== */
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(RELAY_PIN, LOW);

  setupWifi();

  // ✅ SPI with custom MISO / MOSI
  SPI.begin(18, 13, 11, SS_PIN);
  mfrc522.PCD_Init();

  Serial.println("RFID ready");
}


/* ===== LOOP ===== */
void loop() {

  // ✅ ONE heartbeat timer only (you had two)
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 5000) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  /* ---- POLL COMMANDS ---- */
  if (millis() - lastCmdCheck > CMD_INTERVAL) {
    lastCmdCheck = millis();
    checkCommand();
  }

  /* ---- RFID ---- */
  if (!lockdown &&
      mfrc522.PICC_IsNewCardPresent() &&
      mfrc522.PICC_ReadCardSerial()) {

    String uid = "";
    for (byte i = 0; i < mfrc522.uid.size; i++) {
      if (mfrc522.uid.uidByte[i] < 0x10) uid += "0";
      uid += String(mfrc522.uid.uidByte[i], HEX);
    }
    uid.toUpperCase();

    Serial.print("RFID UID: ");
    Serial.println(uid);

    bool ok = isAuthorized(uid);

    if (ok) {
      digitalWrite(GREEN_LED, HIGH);
      digitalWrite(RELAY_PIN, HIGH);
      beepGranted();
      sendAccessEvent(uid, "authorized");

      // ✅ FIX: RFID also sets door OPEN + heartbeat immediately
      doorStatus = "OPEN";
      doorTimer = millis();
      sendHeartbeat();
    } else {
      digitalWrite(RED_LED, HIGH);
      beepDenied();
      sendAccessEvent(uid, "unauthorized");
    }

    actionStart = millis();
    actionActive = true;

    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
  }

  /* ---- RESET OUTPUTS (this is your “door closes when LED goes off”) ---- */
  if (actionActive && millis() - actionStart > 3000) {
    digitalWrite(GREEN_LED, LOW);
    digitalWrite(RED_LED, LOW);
    digitalWrite(RELAY_PIN, LOW);
    actionActive = false;

    // ✅ FIX: if door was open, close it NOW and notify backend
    if (doorStatus == "OPEN") {
      doorStatus = "CLOSED";
      Serial.println("DOOR CLOSED (by reset)");
      sendHeartbeat();
    }
  }

  /* ---- SAFETY AUTO-CLOSE (backup, if reset didn’t run) ---- */
  if (doorStatus == "OPEN" && millis() - doorTimer > 5000) {
    digitalWrite(GREEN_LED, LOW);
    digitalWrite(RELAY_PIN, LOW);
    doorStatus = "CLOSED";
    Serial.println("DOOR CLOSED (by timer)");
    sendHeartbeat();
  }
}