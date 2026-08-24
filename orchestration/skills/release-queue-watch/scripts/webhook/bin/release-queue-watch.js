#!/usr/bin/env node
import { main } from "../src/runtime.js";

main().catch((error) => {
	process.stderr.write(`${error.stack ?? error.message}\n`);
	process.exitCode = 1;
});
