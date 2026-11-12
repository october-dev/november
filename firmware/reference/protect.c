#include "protect.h"

#include <string.h>

static void copy_id(char dest[NOVEMBER_ID_LEN], const char *id) {
  size_t i = 0;
  if (id == 0) {
    dest[0] = '\0';
    return;
  }
  while (id[i] != '\0' && i + 1 < NOVEMBER_ID_LEN) {
    dest[i] = id[i];
    i += 1;
  }
  dest[i] = '\0';
}

static int seen(const NovemberLed *led, const char *id) {
  uint32_t i;
  for (i = 0; i < led->id_count; i += 1) {
    if (strncmp(led->ids[i], id, NOVEMBER_ID_LEN) == 0) return 1;
  }
  return 0;
}

static void remember(NovemberLed *led, const char *id) {
  if (led->id_count >= NOVEMBER_ID_SLOTS) return;
  copy_id(led->ids[led->id_count], id);
  led->id_count += 1;
}

static void turn_off(NovemberLed *led) {
  led->on = false;
  led->deadline_ms = 0;
}

void november_led_init(NovemberLed *led, uint32_t boot_id) {
  memset(led, 0, sizeof(*led));
  led->boot_id = boot_id;
}

void november_led_arm(NovemberLed *led, uint32_t now_ms) {
  led->armed = true;
  led->have_heartbeat = false;
  led->last_heartbeat_ms = now_ms;
}

void november_led_disarm(NovemberLed *led) { led->armed = false; turn_off(led); }

int november_led_command(NovemberLed *led, const char *id, uint32_t requested_ms,
                         uint32_t now_ms) {
  uint32_t active = requested_ms == 0 ? NOVEMBER_PICO_DEFAULT_ACTIVE_MS : requested_ms;
  if (!led->armed || id == 0 || id[0] == '\0') return 0;
  if (active < 1 || active > NOVEMBER_PICO_MAX_ACTIVE_MS) return 0;
  if (seen(led, id)) return 0;
  remember(led, id);
  led->on = true;
  led->deadline_ms = now_ms + active;
  if (!led->have_heartbeat) {
    led->last_heartbeat_ms = now_ms;
    led->have_heartbeat = true;
  }
  return 1;
}

void november_led_heartbeat(NovemberLed *led, uint32_t now_ms) {
  if (!led->armed) return;
  led->last_heartbeat_ms = now_ms;
  led->have_heartbeat = true;
}

void november_led_tick(NovemberLed *led, uint32_t now_ms) {
  if (!led->on) return;
  if (now_ms >= led->deadline_ms) {
    turn_off(led);
    return;
  }
  if (led->have_heartbeat && now_ms - led->last_heartbeat_ms >= NOVEMBER_HEARTBEAT_CUTOFF_MS) {
    turn_off(led);
  }
}
