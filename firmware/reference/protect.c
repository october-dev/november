#include "protect.h"

#include <string.h>

static int id_valid(const char *id) {
  size_t len;
  if (id == 0 || id[0] == '\0') return 0;
  len = strlen(id);
  return len < NOVEMBER_ID_LEN;
}

static int seen(const NovemberLed *led, const char *id) {
  uint32_t i;
  for (i = 0; i < led->id_count; i += 1) {
    if (strncmp(led->ids[i], id, NOVEMBER_ID_LEN) == 0) return 1;
  }
  return 0;
}

static void remember(NovemberLed *led, const char *id) {
  /* The caller guarantees a valid ID and a free slot. */
  strcpy(led->ids[led->id_count], id);
  led->id_count += 1;
}

static void turn_off(NovemberLed *led) {
  led->on = false;
  led->start_ms = 0;
  led->active_ms = 0;
}

/* Settle the output at the caller's time. Whichever limit was reached
 * first decides: duration expiry is normal completion and stays armed;
 * heartbeat loss interrupts the action, so it also disarms until
 * explicitly re-armed. A tie counts as normal completion. Unsigned
 * arithmetic keeps this correct across the 32-bit wrap. An expired
 * heartbeat is forgotten even while off, so a full counter wrap cannot
 * make it look fresh again. */
static void settle(NovemberLed *led, uint32_t now_ms) {
  bool heartbeat_expired =
      led->have_heartbeat &&
      now_ms - led->last_heartbeat_ms >= NOVEMBER_HEARTBEAT_CUTOFF_MS;
  if (heartbeat_expired) led->have_heartbeat = false;
  if (!led->on) return;
  /* While on, the last heartbeat is at most 1999 ms before the start, so
   * the offset from the start to the heartbeat limit is small and exact. */
  if (heartbeat_expired &&
      led->last_heartbeat_ms + NOVEMBER_HEARTBEAT_CUTOFF_MS - led->start_ms <
          led->active_ms) {
    turn_off(led);
    led->armed = false;
    return;
  }
  if (now_ms - led->start_ms >= led->active_ms) turn_off(led);
}

void november_led_init(NovemberLed *led, uint32_t boot_id) {
  memset(led, 0, sizeof(*led));
  led->boot_id = boot_id;
}

void november_led_arm(NovemberLed *led) {
  if (led->armed) return;
  led->armed = true;
}

void november_led_disarm(NovemberLed *led) {
  led->armed = false;
  led->have_heartbeat = false;
  turn_off(led);
}

int november_led_command(NovemberLed *led, const char *id, uint32_t requested_ms,
                         uint32_t now_ms) {
  uint32_t active =
      requested_ms == 0 ? NOVEMBER_PICO_DEFAULT_ACTIVE_MS : requested_ms;
  settle(led, now_ms);
  if (!led->armed || !id_valid(id)) return 0;
  if (active > NOVEMBER_PICO_MAX_ACTIVE_MS) return 0;
  if (seen(led, id)) return 0;
  if (led->on) return 0;
  if (!led->have_heartbeat ||
      now_ms - led->last_heartbeat_ms >= NOVEMBER_HEARTBEAT_CUTOFF_MS) {
    return 0;
  }
  if (led->id_count >= NOVEMBER_ID_SLOTS) return 0;
  remember(led, id);
  led->on = true;
  led->start_ms = now_ms;
  led->active_ms = active;
  return 1;
}

void november_led_heartbeat(NovemberLed *led, uint32_t now_ms) {
  settle(led, now_ms);
  if (!led->armed) return;
  led->last_heartbeat_ms = now_ms;
  led->have_heartbeat = true;
}

void november_led_tick(NovemberLed *led, uint32_t now_ms) {
  settle(led, now_ms);
}
