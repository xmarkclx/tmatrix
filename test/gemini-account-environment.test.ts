import { describe, expect, it } from "vitest";
import gemini from "../src/adapters/gemini/index.js";

describe("Gemini account environment", () => {
  it("isolates the agy login but keeps git and gh on the user's real config", () => {
    const environment = gemini.accounts!.environment("/accounts/gemini/work", {
      HOME: "/home/me", PATH: "/usr/bin", XDG_CONFIG_HOME: "/home/me/.config", GEMINI_API_KEY: "secret"
    });
    expect(environment.HOME).toBe("/accounts/gemini/work");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/home/me/.gitconfig");
    expect(environment.GH_CONFIG_DIR).toBe("/home/me/.config/gh");
    expect(environment.XDG_CONFIG_HOME).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.PATH).toBe("/usr/bin");
  });
});
