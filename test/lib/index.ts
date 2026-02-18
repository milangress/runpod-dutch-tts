import { join } from "path"
import { RunPodClient } from "./client"

export { RunPodClient } from "./client"
export * from "./config"
export * from "./types"

export async function runTest(fn: (client: RunPodClient) => Promise<void>) {
	const client = new RunPodClient()
	try {
		await fn(client)
		console.log("\n✅ Test completed successfully.")
		process.exit(0)
	} catch (err: any) {
		console.error("\n❌ Test failed:", err.message || err)
		await client.cancelAll()
		process.exit(1)
	}
}

/**
 * Returns a file object pointing to `test/output/{subpath}`.
 * Ensure the directory structure exists before writing.
 */
export function outDir(subpath: string) {
	// Assuming this lib is in test/lib/, so import.meta.dir is test/lib
	// We want test/output
	const basePath = join(import.meta.dir, "..", "output")
	return Bun.file(join(basePath, subpath))
}

/**
 * Ensures the directory for the given file path exists.
 * This is useful before writing to a file in a subdirectory.
 */
export async function ensureDir(filePath: string) {
	const dir = join(filePath, "..")
	// Bun doesn't have mkdir yet, so we use node:fs
	const { mkdir } = await import("node:fs/promises")
	await mkdir(dir, { recursive: true })
}
