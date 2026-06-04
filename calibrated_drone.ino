#include <Wire.h>

#define MPU_ADDR   0x68

#define AX_OFFSET  -1447
#define AY_OFFSET  -283
#define AZ_OFFSET  -1255
#define GX_OFFSET  337
#define GY_OFFSET  -12
#define GZ_OFFSET  75

void readRaw(int16_t &ax, int16_t &ay, int16_t &az,
             int16_t &gx, int16_t &gy, int16_t &gz) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 14, true);
  ax = Wire.read() << 8 | Wire.read();
  ay = Wire.read() << 8 | Wire.read();
  az = Wire.read() << 8 | Wire.read();
  Wire.read(); Wire.read();
  gx = Wire.read() << 8 | Wire.read();
  gy = Wire.read() << 8 | Wire.read();
  gz = Wire.read() << 8 | Wire.read();
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B); Wire.write(0);
  Wire.endTransmission(true);
  delay(1000);
  Serial.println("=== VERIFICATION - Place sensor flat and still ===");
  delay(3000);
  Serial.println("Reading calibrated values now:");
}

void loop() {
  int16_t ax, ay, az, gx, gy, gz;
  readRaw(ax, ay, az, gx, gy, gz);

  ax += AX_OFFSET; ay += AY_OFFSET; az += AZ_OFFSET;
  gx += GX_OFFSET; gy += GY_OFFSET; gz += GZ_OFFSET;

  float ax_g = ax / 16384.0;
  float ay_g = ay / 16384.0;
  float az_g = az / 16384.0;
  float gx_d = gx / 131.0;
  float gy_d = gy / 131.0;
  float gz_d = gz / 131.0;

  Serial.print("Accel(g)  X:"); Serial.print(ax_g, 3);
  Serial.print("  Y:"); Serial.print(ay_g, 3);
  Serial.print("  Z:"); Serial.println(az_g, 3);

  Serial.print("Gyro(d/s) X:"); Serial.print(gx_d, 3);
  Serial.print("  Y:"); Serial.print(gy_d, 3);
  Serial.print("  Z:"); Serial.println(gz_d, 3);
  Serial.println("---");
  delay(500);
}