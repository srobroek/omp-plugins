import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pkg from "../package.json" with { type: "json" };

const BUILD_PRESENT = Symbol.for("com.srobroek.build.present.v1");
(globalThis as Record<symbol, unknown>)[BUILD_PRESENT] = { version: pkg.version };

/** Register no runtime behavior; loading this extension marks the plugin present. */
export default function presence(_pi: ExtensionAPI): void {}
