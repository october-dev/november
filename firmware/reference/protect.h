#ifndef NOVEMBER_PROTECT_H
#define NOVEMBER_PROTECT_H

#include <stdbool.h>
#include <stdint.h>

/* Host simulation of the reference Pico LED protection rules.
 *
 * Build the host test: gcc -std=c11 -Wall -Wextra -Werror -o protect-test \
 *   firmware/reference/protect.c firmware/reference/test_protect.c
 * Do not flash hardware from tests. A Pico image needs the ARM toolchain,
 * which is not pinned here, and an explicit manual BOOTSEL step.
 *
 * Time contract: the caller supplies a monotonic millisecond clock modulo
 * 2^32 and drives every transition by calling tick/heartbeat/command in
 * event order. Duration expiry compares unsigned elapsed time against the
 * stored duration, so it is correct across the 32-bit wrap as long as time
 * only moves forward. Ticks must run often enough to observe the cutoff;
 * this model schedules nothing by itself.
 *
 * Admission rule: a command returns 1 only while armed, only when the
 * output is off, only with a valid ID the history can retain, and only
 * when a heartbeat arrived less than NOVEMBER_HEARTBEAT_CUTOFF_MS ago.
 * A refused command (return 0) never changes the output, the activation,
 * or the remembered IDs.
 *
 * The LED turns off by itself when its duration elapses (normal completion,
 * stays armed) and within 2s of the last heartbeat. Heartbeat loss means
 * the host may be gone, so that cutoff also disarms: an interrupted action
 * resumes only after an explicit re-arm. Re-arming while armed changes
 * nothing; disarming switches off immediately and clears heartbeat state
 * but preserves remembered IDs. A duplicate command, a heartbeat, or a
 * fresh ID can never extend or move a running activation.
 *
 * Command IDs are at most 15 bytes plus the terminating NUL
 * (NOVEMBER_ID_LEN covers both). Longer IDs are refused before copying.
 * At most NOVEMBER_ID_SLOTS distinct IDs are remembered; a fresh ID past
 * capacity is refused rather than activated without history.
 *
 * Boot identity is caller-owned: init() records the supplied boot_id and
 * clears the history. Generating unique boot IDs across real resets is the
 * platform layer's job, not this module's.
 *
 * The return value is admission-only: 1 means this call turned the output
 * on, 0 means it did not (including a duplicate of a command that ran
 * before). It is not the command's final outcome.
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
  uint32_t start_ms;
  uint32_t active_ms;
  uint32_t last_heartbeat_ms;
  bool have_heartbeat;
  char ids[NOVEMBER_ID_SLOTS][NOVEMBER_ID_LEN];
  uint32_t id_count;
} NovemberLed;

void november_led_init(NovemberLed *led, uint32_t boot_id);
void november_led_arm(NovemberLed *led);
void november_led_disarm(NovemberLed *led);
/* Returns 1 only after the output is on. 0 means it was not turned on. */
int november_led_command(NovemberLed *led, const char *id, uint32_t requested_ms,
                         uint32_t now_ms);
void november_led_heartbeat(NovemberLed *led, uint32_t now_ms);
void november_led_tick(NovemberLed *led, uint32_t now_ms);

#endif
