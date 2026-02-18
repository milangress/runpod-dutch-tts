import runpodSdk from "runpod-sdk"
import { loadConfig } from "./config"
import type { RunPodJobInput, RunPodStatusResponse } from "./types"

type RunpodSdk = ReturnType<typeof runpodSdk>
type Endpoint = NonNullable<ReturnType<RunpodSdk["endpoint"]>>

const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const POLL_INTERVAL_MS = 2000

export class RunPodClient {
	private runpod: RunpodSdk
	private endpoint: Endpoint
	private activeJobs = new Set<string>()

	constructor() {
		const config = loadConfig()
		this.runpod = runpodSdk(config.RUNPOD_API_KEY)
		this.endpoint = this.runpod.endpoint(config.ENDPOINT_ID) as Endpoint

		if (!this.endpoint) {
			console.error(`Missing endpoint for ID: ${config.ENDPOINT_ID} `)
			process.exit(1)
		}

		// Handle cancellation
		process.on("SIGINT", async () => {
			console.log("\n\n🛑 Interrupted! Canceling active jobs...")
			await this.cancelAll()
			process.exit(1)
		})
	}

	async submitJob(input: RunPodJobInput): Promise<string> {
		try {
			const result = await this.endpoint.run({ input })
			const id = result.id
			if (!id) throw new Error("No job ID returned from RunPod")
			this.activeJobs.add(id)
			return id
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			throw new Error(`Failed to submit job: ${message} `)
		}
	}

	async waitForJob(id: string): Promise<RunPodStatusResponse> {
		const start = Date.now()
		let failures = 0

		while (Date.now() - start < TIMEOUT_MS) {
			try {
				const status = (await this.endpoint.status(id)) as RunPodStatusResponse

				if (status.status === "COMPLETED") {
					this.activeJobs.delete(id)
					return status
				}

				if (status.status === "FAILED") {
					this.activeJobs.delete(id)
					throw new Error(status.error || "Job failed without error message")
				}

				failures = 0 // Reset on success
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			} catch (err: unknown) {
				failures++
				if (failures > 3) {
					const message = err instanceof Error ? err.message : String(err)
					console.warn(`   ⚠️ Status check failed ${failures} times for ${id}: `, message)
				}
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			}
		}

		await this.cancelJob(id)
		throw new Error(`Job ${id} timed out after ${TIMEOUT_MS} ms`)
	}

	async run(input: RunPodJobInput): Promise<RunPodStatusResponse> {
		const id = await this.submitJob(input)
		return this.waitForJob(id)
	}

	async cancelJob(id: string) {
		if (!this.activeJobs.has(id)) return
		try {
			// endpoint.cancel might assume { id } or just id, checking docs logic or just standard usage
			// Usually runpod sdk endpoint.cancel takes the id string
			await this.endpoint.cancel(id)
			this.activeJobs.delete(id)
			console.log(`   ⛔ Canceled job ${id} `)
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err)
			console.error(`   ⚠️ Failed to cancel job ${id}: `, message)
		}
	}

	async cancelAll() {
		const jobs = Array.from(this.activeJobs)
		if (jobs.length === 0) return
		await Promise.all(jobs.map((id) => this.cancelJob(id)))
	}
}
