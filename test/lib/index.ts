
import { join } from "path"
import { RunPodClient } from "./client"

export { concatenateWavBuffers, loadAudioPrompt } from "./audio"
export { RunPodClient } from "./client"
export * from "./config"
export { printSummary } from "./display"
export * from "./errors"
export * from "./types"
export { runWithUI } from "./ui"

import { logErrorToFile, logToFile } from "./logger"

export async function runTest(fn: (client: RunPodClient) => Promise<void>) {
	const client = new RunPodClient()
	try {
		await fn(client)
		logToFile("Test completed successfully.")
	} catch (err: any) {
		const msg = err.message || err
		logErrorToFile("Test failed", msg)
		await client.cancelAll()
		throw err
	}
}

/**
 * Helper to write output files relative to `test/output`.
 * Automatically ensures directories exist and logs the operation to file.
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

	// Log result to file
	const sizeKB = (file.size / 1024).toFixed(1)
	logToFile(`Output: ${subpath} — ${sizeKB} KB`)

	return {
		file,
		path: subpath,
		sizeKB,
	}
}
