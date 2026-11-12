#ifndef NOVEMBER_PROTECT_H
#define NOVEMBER_PROTECT_H

#include <stdbool.h>
#include <stdint.h>

/* Host simulation of the reference Pico LED rules.
 * Build: gcc -std=c11 -Wall -Wextra -Werror
 * Do not flash hardware from tests. A Pico image needs the ARM toolchain,
 * which is not pinned here, and an explicit manual BOOTSEL step.
 */

#define NOVEMBER_PICO_MAX_ACTIVE_MS 30000u
#define NOVEMBER_PICO_DEFAULT_ACTIVE_MS 2000u
#define NOVEMBER_HEARTBEAT_CUTOFF_MS 2000u
#define NOVEMBER_ID_LEN 16
#define NOVEMBER_ID_SLOTS 8

typedef struct {
  bool armed;
  bool on;
  uint32_t boot_id;
  uint32_t deadline_ms;
  uint32_t last_heartbeat_ms;
  bool have_heartbeat;
  char ids[NOVEMBER_ID_SLOTS][NOVEMBER_ID_LEN];
  uint32_t id_count;
} NovemberLed;

void november_led_init(NovemberLed *led, uint32_t boot_id);
void november_led_arm(NovemberLed *led, uint32_t now_ms);
void november_led_disarm(NovemberLed *led);
/* Returns 1 only after the output is on. 0 means it was not turned on. */
int november_led_command(NovemberLed *led, const char *id, uint32_t requested_ms,
                         uint32_t now_ms);
void november_led_heartbeat(NovemberLed *led, uint32_t now_ms);
void november_led_tick(NovemberLed *led, uint32_t now_ms);

#endif
