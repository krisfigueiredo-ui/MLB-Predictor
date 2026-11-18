import { configDefaults, defineConfig } from "vitest/config";

// courtside-iq/ is a separate application with its own test runner and CI workflow.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "courtside-iq/**"] },
});
