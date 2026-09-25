import { describe, expect, test } from "bun:test";
import { sessionNameAction } from "../src/session-name.ts";

describe("session name defaults", () => {
  test("assigns coding placeholder to unnamed session", () => {
    expect(sessionNameAction({ current: undefined })).toEqual({ set: "pitako:coding" });
  });

  test("preserves an existing name", () => {
    expect(sessionNameAction({ current: "Manual title" })).toEqual({});
  });
});
