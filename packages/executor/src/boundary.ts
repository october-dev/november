/**
 * The model process has no successful device or credential open. OS accounts
 * that enforce this with file ownership belong to the service unit (#22).
 * This guard is what the model-side code can call, and it always fails.
 */
const BLOCKED_PATH = /^\/dev\/(?:gpio|i2c|spidev|tty|gpiomem|mem)/;

export function modelProcessOpen(target: string): never {
  if (
    BLOCKED_PATH.test(target) ||
    target.includes("credential") ||
    target.startsWith("/etc/november")
  ) {
    throw new Error(
      "model process cannot open device files or actuator credentials",
    );
  }
  throw new Error(
    "model process cannot open device files or actuator credentials",
  );
}

export function modelProcessShell(): never {
  throw new Error("model process cannot run a shell");
}
