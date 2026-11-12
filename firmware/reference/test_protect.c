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
  NovemberLed restarted;

  november_led_init(&led, 1);
  expect(!led.armed && !led.on && led.boot_id == 1, "boots off and disarmed");
  expect(november_led_command(&led, "cmd-1", 1000, 0) == 0, "disarmed command does nothing");
  expect(!led.on, "still off");

  november_led_arm(&led, 0);
  expect(november_led_command(&led, "cmd-1", 0, 0) == 1, "default duration accepted");
  expect(led.on, "output on only after accept");
  november_led_heartbeat(&led, 1999);
  november_led_tick(&led, 1999);
  expect(led.on, "still on just before the default deadline");
  november_led_tick(&led, 2000);
  expect(!led.on, "off at the deadline");

  expect(november_led_command(&led, "cmd-2", 30000, 10000) == 1, "max duration accepted");
  expect(november_led_command(&led, "cmd-2", 30000, 10000) == 0, "duplicate does not extend");
  november_led_heartbeat(&led, 39000);
  november_led_tick(&led, 40000);
  expect(!led.on, "heartbeat did not extend the deadline");
  expect(november_led_command(&led, "cmd-3", 30001, 50000) == 0, "over max rejected");
  expect(!led.on, "rejected command left the output off");

  expect(november_led_command(&led, "cmd-4", 30000, 60000) == 1, "long command");
  november_led_heartbeat(&led, 60000);
  november_led_tick(&led, 61999);
  expect(led.on, "inside the heartbeat window");
  november_led_tick(&led, 62000);
  expect(!led.on, "heartbeat loss cuts the output");

  november_led_init(&restarted, led.boot_id + 1);
  expect(!restarted.armed && !restarted.on, "reset starts disarmed");
  expect(restarted.boot_id != led.boot_id, "reset changes the boot id");
  november_led_arm(&restarted, 0);
  expect(november_led_command(&restarted, "cmd-1", 1000, 0) == 1,
         "command history does not survive reset");

  if (failures != 0) {
    fprintf(stderr, "%d firmware simulation checks failed\n", failures);
    return 1;
  }
  return 0;
}
