#include "protect.h"

#include <stdio.h>

static int failures = 0;

static void expect(int cond, const char *detail) {
  if (!cond) {
    fprintf(stderr, "fail: %s\n", detail);
    failures += 1;
  }
}

int main(void) {
  NovemberLed led;
  NovemberLed fresh;
  NovemberLed restarted;
  uint32_t t;
  uint32_t i;
  char id[8];

  november_led_init(&led, 1);
  expect(!led.armed && !led.on && led.boot_id == 1, "boots off and disarmed");
  expect(november_led_command(&led, "cmd-1", 1000, 0) == 0,
         "disarmed command does nothing");
  expect(!led.on, "still off");

  november_led_arm(&led);
  november_led_heartbeat(&led, 0);
  expect(november_led_command(&led, "cmd-1", 0, 0) == 1, "default duration accepted");
  expect(led.on, "output on only after accept");
  november_led_heartbeat(&led, 1999);
  november_led_tick(&led, 1999);
  expect(led.on, "still on just before the default deadline");
  november_led_tick(&led, 2000);
  expect(!led.on, "off at the deadline");
  expect(led.armed, "normal expiry stays armed");

  /* Maximum duration with continuous valid heartbeats. */
  november_led_init(&fresh, 2);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 10000);
  expect(november_led_command(&fresh, "cmd-2", 30000, 10000) == 1,
         "max duration accepted");
  expect(fresh.on, "max duration output on");
  for (t = 11000; t <= 39000; t += 1000) {
    november_led_heartbeat(&fresh, t);
    november_led_tick(&fresh, t);
    expect(fresh.on, "max duration stays on with fresh heartbeats");
  }
  expect(november_led_command(&fresh, "cmd-2", 30000, 39000) == 0,
         "duplicate does not extend");
  november_led_heartbeat(&fresh, 39999);
  november_led_tick(&fresh, 39999);
  expect(fresh.on, "still on just before the max deadline");
  november_led_tick(&fresh, 40000);
  expect(!fresh.on, "heartbeat did not extend the deadline");
  expect(november_led_command(&fresh, "cmd-3", 30001, 50000) == 0,
         "over max rejected");
  expect(!fresh.on, "rejected command left the output off");

  /* A fresh command while on is refused without moving the deadline. */
  november_led_init(&fresh, 3);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 0) == 1, "first activation on");
  expect(fresh.on, "busy scenario starts on");
  for (t = 1000; t <= 29000; t += 1000) {
    november_led_heartbeat(&fresh, t);
    november_led_tick(&fresh, t);
    expect(fresh.on, "busy scenario stays on");
  }
  expect(november_led_command(&fresh, "b", 30000, 29000) == 0,
         "fresh id refused while on");
  november_led_heartbeat(&fresh, 29999);
  november_led_tick(&fresh, 29999);
  expect(fresh.on, "original deadline not extended");
  november_led_tick(&fresh, 30000);
  expect(!fresh.on, "off at the original deadline");
  november_led_heartbeat(&fresh, 30000);
  expect(november_led_command(&fresh, "b", 1000, 30000) == 1,
         "refused id was never recorded");

  /* A shorter overlapping command must not shorten the deadline either. */
  november_led_init(&fresh, 4);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 0) == 1,
         "overlap scenario starts on");
  november_led_heartbeat(&fresh, 5000);
  expect(november_led_command(&fresh, "c", 1000, 5000) == 0,
         "shorter overlap refused");
  for (t = 6000; t <= 29000; t += 1000) {
    november_led_heartbeat(&fresh, t);
    november_led_tick(&fresh, t);
  }
  november_led_heartbeat(&fresh, 29999);
  november_led_tick(&fresh, 29999);
  expect(fresh.on, "original deadline not shortened");
  november_led_tick(&fresh, 30000);
  expect(!fresh.on, "off at the unmoved deadline");

  /* A replay after expiry is a duplicate, not a busy rejection. */
  november_led_init(&fresh, 5);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "d", 1000, 0) == 1, "replay case accepted");
  november_led_heartbeat(&fresh, 999);
  november_led_tick(&fresh, 1000);
  expect(!fresh.on, "replay case finished");
  november_led_heartbeat(&fresh, 2000);
  expect(november_led_command(&fresh, "d", 1000, 2000) == 0,
         "replay after expiry refused");
  expect(!fresh.on, "replay after expiry stays off");

  /* Re-arming must not disable the heartbeat cutoff. */
  november_led_init(&fresh, 6);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 0) == 1, "re-arm case accepted");
  expect(fresh.on, "re-arm case on");
  november_led_arm(&fresh);
  november_led_tick(&fresh, 1999);
  expect(fresh.on, "re-arm keeps output inside the window");
  november_led_tick(&fresh, 2000);
  expect(!fresh.on, "re-arm keeps the cutoff");

  /* Disarm switches off at once; history survives re-arm. */
  november_led_init(&fresh, 7);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 2000, 0) == 1, "disarm case accepted");
  november_led_disarm(&fresh);
  expect(!fresh.on && !fresh.armed, "disarm switches off immediately");
  expect(november_led_command(&fresh, "b", 1000, 100) == 0,
         "commands refused until re-armed");
  november_led_arm(&fresh);
  expect(november_led_command(&fresh, "b", 1000, 100) == 0,
         "re-arm needs a fresh heartbeat");
  november_led_heartbeat(&fresh, 100);
  expect(november_led_command(&fresh, "a", 1000, 100) == 0,
         "history preserved across disarm");
  expect(!fresh.on, "duplicate after re-arm stays off");
  expect(november_led_command(&fresh, "b", 1000, 100) == 1,
         "fresh id works after re-arm");

  /* Heartbeat cutoff disarms; an interrupted action needs a re-arm. */
  november_led_init(&fresh, 8);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 0) == 1, "cutoff case accepted");
  november_led_tick(&fresh, 2000);
  expect(!fresh.on && !fresh.armed, "heartbeat cutoff disarms");
  november_led_heartbeat(&fresh, 2001);
  expect(november_led_command(&fresh, "b", 1000, 2001) == 0,
         "no activation after cutoff without re-arm");
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 2001);
  expect(november_led_command(&fresh, "b", 1000, 2001) == 1,
         "re-arm after cutoff works");

  /* Stale admission: the output must never turn on. */
  november_led_init(&fresh, 9);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  november_led_tick(&fresh, 10000);
  expect(!fresh.on, "tick while off stays off");
  expect(november_led_command(&fresh, "a", 30000, 10000) == 0,
         "ten-second-old heartbeat refused");
  expect(!fresh.on, "stale admission never turns on");

  november_led_init(&fresh, 10);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 1999) == 1,
         "heartbeat age 1999 accepted");
  expect(fresh.on, "1999 admission turns on");

  november_led_init(&fresh, 11);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "a", 30000, 2000) == 0,
         "heartbeat age 2000 refused");
  expect(!fresh.on, "boundary admission never turns on");

  november_led_init(&fresh, 12);
  november_led_arm(&fresh);
  expect(november_led_command(&fresh, "a", 30000, 0) == 0,
         "no heartbeat refused");
  expect(!fresh.on, "no-heartbeat admission never turns on");

  /* All eight slots fill across separate completed activations. */
  november_led_init(&fresh, 13);
  november_led_arm(&fresh);
  for (i = 0; i < NOVEMBER_ID_SLOTS; i += 1) {
    t = 1000 + i * 1000;
    snprintf(id, sizeof(id), "cap-%u", i);
    november_led_heartbeat(&fresh, t);
    expect(november_led_command(&fresh, id, 100, t) == 1, "capacity slot accepted");
    expect(fresh.on, "capacity slot on");
    november_led_heartbeat(&fresh, t + 99);
    november_led_tick(&fresh, t + 100);
    expect(!fresh.on, "capacity slot finished");
  }
  expect(fresh.id_count == NOVEMBER_ID_SLOTS, "all slots remembered");
  for (i = 0; i < NOVEMBER_ID_SLOTS; i += 1) {
    t = 20000 + i * 100;
    snprintf(id, sizeof(id), "cap-%u", i);
    november_led_heartbeat(&fresh, t);
    expect(november_led_command(&fresh, id, 100, t) == 0,
           "stored id replay refused after expiry");
    expect(!fresh.on, "stored id replay stays off");
  }
  november_led_heartbeat(&fresh, 30000);
  expect(november_led_command(&fresh, "cap-8", 100, 30000) == 0,
         "ninth id refused at capacity");
  expect(!fresh.on, "refused ninth id leaves output off");
  expect(fresh.id_count == NOVEMBER_ID_SLOTS, "ninth id not recorded");
  expect(november_led_command(&fresh, "cap-8", 100, 30000) == 0,
         "ninth id repeat refused");
  expect(fresh.id_count == NOVEMBER_ID_SLOTS, "ninth id repeat not recorded");

  /* ID length: 15 bytes fit, 16 are refused before copying. */
  november_led_init(&fresh, 14);
  november_led_arm(&fresh);
  november_led_heartbeat(&fresh, 0);
  expect(november_led_command(&fresh, "0123456789abcdef", 2000, 0) == 0,
         "16-byte id refused");
  expect(!fresh.on && fresh.id_count == 0, "overlong id consumes no slot");
  expect(november_led_command(&fresh, "0123456789abcde", 2000, 0) == 1,
         "15-byte prefix still fresh");
  expect(fresh.on, "15-byte id turns on");
  november_led_heartbeat(&fresh, 100);
  expect(november_led_command(&fresh, "0123456789abcde", 2000, 100) == 0,
         "15-byte id duplicate during activation");
  expect(fresh.on, "duplicate during activation stays on");
  november_led_heartbeat(&fresh, 1999);
  november_led_tick(&fresh, 2000);
  expect(!fresh.on, "15-byte activation finished");
  november_led_heartbeat(&fresh, 3000);
  expect(november_led_command(&fresh, "0123456789abcde", 2000, 3000) == 0,
         "15-byte id duplicate after expiry");
  expect(november_led_command(&fresh, "0123456789abcdeX", 2000, 3000) == 0,
         "16-byte id sharing the prefix refused");
  expect(fresh.id_count == 1, "overlong prefix id consumes no slot");
  expect(november_led_command(&fresh, "0123456789abcdf", 1000, 3000) == 1,
         "15-byte ids differing in the last byte stay distinct");
  november_led_heartbeat(&fresh, 3999);
  november_led_tick(&fresh, 4000);
  november_led_heartbeat(&fresh, 5000);
  expect(november_led_command(&fresh, "", 100, 5000) == 0, "empty id refused");
  expect(november_led_command(&fresh, 0, 100, 5000) == 0, "null id refused");
  expect(!fresh.on, "invalid ids leave output off");

  /* Wrap-safe duration: no early cutoff across the 32-bit wrap. */
  {
    const uint32_t start = UINT32_MAX - 1000u;
    november_led_init(&fresh, 15);
    november_led_arm(&fresh);
    november_led_heartbeat(&fresh, start);
    expect(november_led_command(&fresh, "w1", 2000, start) == 1,
           "wrap activation accepted");
    expect(fresh.on, "wrap activation on");
    november_led_tick(&fresh, start + 1u);
    expect(fresh.on, "no early cutoff before the wrap");
    november_led_heartbeat(&fresh, start + 1000u);
    november_led_tick(&fresh, start + 1999u);
    expect(fresh.on, "wrap activation on before its deadline");
    november_led_tick(&fresh, start + 2000u);
    expect(!fresh.on, "wrap activation off at its deadline");
  }

  /* Wrap-safe duration: expiry is not missed across the wrap. */
  {
    const uint32_t start = UINT32_MAX - 1005u;
    november_led_init(&fresh, 16);
    november_led_arm(&fresh);
    november_led_heartbeat(&fresh, start);
    expect(november_led_command(&fresh, "w2", 1000, start) == 1,
           "wrap expiry case accepted");
    november_led_tick(&fresh, UINT32_MAX - 10u);
    expect(fresh.on, "wrap expiry case on before its deadline");
    november_led_tick(&fresh, 4u);
    expect(!fresh.on, "wrap expiry case off after its deadline");
  }

  november_led_init(&restarted, led.boot_id + 1);
  expect(!restarted.armed && !restarted.on, "reset starts disarmed");
  expect(restarted.boot_id != led.boot_id, "caller supplies the new boot id");
  november_led_arm(&restarted);
  november_led_heartbeat(&restarted, 0);
  expect(november_led_command(&restarted, "cmd-1", 1000, 0) == 1,
         "init clears the command history");

  if (failures != 0) {
    fprintf(stderr, "%d firmware simulation checks failed\n", failures);
    return 1;
  }
  return 0;
}
