import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("published tarball installs and imports in a fresh Node process", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-compact-package-"));
	try {
		const npmrc = join(root, "npmrc");
		writeFileSync(npmrc, "");
		const env = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
		delete env.NPM_TOKEN;
		delete env.NODE_AUTH_TOKEN;
		const packed = JSON.parse(execFileSync("npm", [
			"pack", "--json", "--ignore-scripts", "--pack-destination", root,
		], { cwd: project, env, encoding: "utf8" }))[0];
		assert(packed.files.some((entry) => entry.path === "lib/index.js"));
		assert(!packed.files.some((entry) => /^(test|e2e|node_modules)\//.test(entry.path)));
		execFileSync("npm", [
			"install", "--prefix", root, "--offline", "--ignore-scripts", "--no-audit",
			"--no-fund", "--package-lock=false", join(root, packed.filename),
		], { env, encoding: "utf8", stdio: "pipe" });
		const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
		const output = execFileSync(process.execPath, [
			"--input-type=module", "-e",
			`const plugin = await import(${JSON.stringify(pkg.name)}); console.log(JSON.stringify({ name: plugin.name, apply: typeof plugin.apply }));`,
		], { cwd: root, env, encoding: "utf8" });
		assert.deepEqual(JSON.parse(output), { name: pkg.name, apply: "function" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
