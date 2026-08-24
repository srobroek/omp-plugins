import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const SECRET_FILE = "webhook-secret";

async function readSecret(path) {
	const secret = (await readFile(path, "utf8")).trim();
	if (!/^[a-f0-9]{64}$/.test(secret)) {
		throw new Error(`invalid webhook secret at ${path}`);
	}
	return secret;
}

export async function loadOrCreateWebhookSecret(stateDir, options = {}) {
	const random = options.randomBytes ?? randomBytes;
	const path = join(stateDir, SECRET_FILE);
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	await chmod(stateDir, 0o700);

	try {
		return { created: false, path, secret: await readSecret(path) };
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const secret = random(32).toString("hex");
	try {
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(`${secret}\n`, "utf8");
		} finally {
			await handle.close();
		}
		await chmod(path, 0o600);
		return { created: true, path, secret };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		return { created: false, path, secret: await readSecret(path) };
	}
}
