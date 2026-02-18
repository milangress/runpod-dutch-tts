export * from "./client"
export * from "./config"
export * from "./types"

import { RunPodClient } from "./client"

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
