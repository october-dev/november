import { describe, expect, it } from "vitest";
import { SERVICE_NAME, serviceHealth } from "./index.js";

describe("service health", () => {
  it("reports the scaffold as not ready and disarmed", () => {
    expect(serviceHealth()).toEqual({
      name: SERVICE_NAME,
      ready: false,
      armed: false,
    });
  });
});
