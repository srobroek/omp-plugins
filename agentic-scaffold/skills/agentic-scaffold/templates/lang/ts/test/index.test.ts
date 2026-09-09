import { expect, test } from "bun:test";
import { packageName } from "../src/index";

test("exports the package name", () => {
  expect(packageName).toBe("${package_kebab}");
});
