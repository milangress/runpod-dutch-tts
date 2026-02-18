
import { join } from "path"
import { RunPodClient } from "./client"

export { RunPodClient } from "./client"
export * from "./config"
export * from "./errors"
export * from "./types"

export async function runTest(fn: (client: RunPodClient) => Promise<void>) {
	const client = new RunPodClient()
	try {
		await fn(client)
		console.log("\n✅ Test completed successfully.")
	} catch (err: any) {
		console.error("\n❌ Test failed:", err.message || err)
		await client.cancelAll()
		throw err
	}
}

/**
 * Helper to write output files relative to `test/output`.
 * Automatically ensures directories exist and logs the operation.
 */
export async function writeOutput(subpath: string, data: string | Buffer | Uint8Array) {
	const basePath = join(import.meta.dir, "..", "output")
	const filePath = join(basePath, subpath)

	// Ensure directory exists
	const { mkdir } = await import("node:fs/promises")
	await mkdir(join(filePath, ".."), { recursive: true })

	const file = Bun.file(filePath)

	// Write file using Bun
	await Bun.write(file, data)


	// Log result
	const sizeKB = (file.size / 1024).toFixed(1)
	console.log(`   ${subpath} — ${sizeKB} KB`)

	return file
}
