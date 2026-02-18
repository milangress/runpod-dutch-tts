import runpodSdk from "runpod-sdk"
import { loadConfig } from "./config"
import { JobFailedError, JobTimeoutError, RunPodError, ensureError } from "./errors"
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
		const endpoint = this.runpod.endpoint(config.ENDPOINT_ID)

		if (!endpoint) {
			throw new RunPodError(`Missing endpoint for ID: ${config.ENDPOINT_ID}`)
		}

		this.endpoint = endpoint as Endpoint

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
			if (!id) throw new RunPodError("No job ID returned from RunPod")
			this.activeJobs.add(id)
			return id
		} catch (err: unknown) {
			throw new RunPodError(`Failed to submit job: ${ensureError(err).message}`)
		}
	}

	async waitForJob(id: string): Promise<RunPodStatusResponse> {
		const start = Date.now()
		let failures = 0

		while (Date.now() - start < TIMEOUT_MS) {
			try {
				const status = (await this.endpoint.status(id)) as RunPodStatusResponse

				// Check for application-level errors in output
				if (status.output && typeof status.output === "object" && "error" in status.output) {
					throw new JobFailedError(id, `Application error: ${status.output.error}`)
				}

				if (status.status === "COMPLETED") {
					this.activeJobs.delete(id)
					return status
				}

				if (status.status === "FAILED") {
					this.activeJobs.delete(id)
					throw new JobFailedError(id, status.error || "Job failed without error message")
				}

				failures = 0 // Reset on success
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			} catch (err: unknown) {
				if (err instanceof RunPodError) throw err

				failures++
				if (failures > 3) {
					console.warn(`   ⚠️ Status check failed ${failures} times for ${id}:`, ensureError(err).message)
				}
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			}
		}

		await this.cancelJob(id)
		throw new JobTimeoutError(id, TIMEOUT_MS)
	}

	async run(input: RunPodJobInput): Promise<RunPodStatusResponse> {
		const id = await this.submitJob(input)
		return this.waitForJob(id)
	}

	/**
	 * Extracts audio buffers from a completed job response.
	 * Guarantees at least one buffer or throws RunPodError.
	 */
	getAudio(response: RunPodStatusResponse): Buffer[] {
		if (!response.output) {
			throw new RunPodError("Response has no output")
		}

		const output = response.output
		if (!output.audio || !Array.isArray(output.audio)) {
			throw new RunPodError("Response output missing 'audio' array")
		}

		if (output.audio.length === 0) {
			throw new RunPodError("API returned empty audio array")
		}

		return output.audio.map((b64, i) => {
			if (!b64 || typeof b64 !== "string") {
				throw new RunPodError(`Invalid base64 string at index ${i}`)
			}
			return Buffer.from(b64, "base64")
		})
	}

	async cancelJob(id: string) {
		if (!this.activeJobs.has(id)) return
		try {
			await this.endpoint.cancel(id)
			this.activeJobs.delete(id)
			console.log(`   ⛔ Canceled job ${id}`)
		} catch (err: unknown) {
			console.error(`   ⚠️ Failed to cancel job ${id}:`, ensureError(err).message)
		}
	}

	async cancelAll() {
		const jobs = Array.from(this.activeJobs)
		if (jobs.length === 0) return
		await Promise.all(jobs.map((id) => this.cancelJob(id)))
	}
}
