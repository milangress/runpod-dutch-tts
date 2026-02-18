import runpodSdk from "runpod-sdk"
import { loadAudioPrompt } from "./audio"
import { loadConfig } from "./config"
import { printSummary } from "./display"
import { RunPodError, ensureError } from "./errors"
import { logErrorToFile, logToFile } from "./logger"
import { executeAll } from "./tracker"
import type {
	AudioPrompt,
	ItemRequest,
	RunAllOptions,
	RunPodJobInput,
	RunPodStatusResponse,
	TrackedItem,
} from "./types"

type RunpodSdk = ReturnType<typeof runpodSdk>
export type Endpoint = NonNullable<ReturnType<RunpodSdk["endpoint"]>>

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
		logToFile(`🔌 Connected to RunPod endpoint: ${config.ENDPOINT_ID}`)
	}

	// ── High-level API ──────────────────────────────────────────

	/**
	 * Submit, auto-batch, poll, and track an array of items.
	 * Items with matching params are batched into single RunPod jobs.
	 * Returns one TrackedItem per input, fully resolved with audio buffers.
	 */
	async runAll<T = void>(
		items: ItemRequest<T>[],
		options: RunAllOptions<T> = {}
	): Promise<TrackedItem<T>[]> {
		return executeAll(this.endpoint, this.activeJobs, items, options)
	}

	/**
	 * Load an audio prompt file for voice cloning.
	 * Path is resolved relative to the test/ directory.
	 */
	async loadAudioPrompt(filePath: string): Promise<AudioPrompt> {
		return loadAudioPrompt(filePath)
	}

	/**
	 * Print a formatted summary table from tracked items.
	 */
	printSummary<T>(
		items: TrackedItem<T>[],
		columns: (item: TrackedItem<T>) => Record<string, string | number | undefined>
	): void {
		printSummary(items, columns)
	}

	// ── Low-level API (still available) ─────────────────────────

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
		const TIMEOUT_MS = 10 * 60 * 1000
		const POLL_INTERVAL_MS = 2000
		const start = Date.now()
		let failures = 0

		while (Date.now() - start < TIMEOUT_MS) {
			try {
				const status = (await this.endpoint.status(id)) as RunPodStatusResponse

				if (status.output && typeof status.output === "object" && "error" in status.output) {
					throw new RunPodError(`Application error: ${status.output.error}`)
				}

				if (status.status === "COMPLETED") {
					this.activeJobs.delete(id)
					return status
				}

				if (status.status === "FAILED") {
					this.activeJobs.delete(id)
					throw new RunPodError(`Job ${id} failed: ${status.error || "unknown"}`)
				}

				failures = 0
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			} catch (err: unknown) {
				if (err instanceof RunPodError) throw err
				failures++
				if (failures > 3) {
					logToFile(`⚠️ Status check failed ${failures} times for ${id}: ${ensureError(err).message}`)
				}
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
			}
		}

		await this.cancelJob(id)
		throw new RunPodError(`Job ${id} timed out after ${TIMEOUT_MS}ms`)
	}

	async run(input: RunPodJobInput): Promise<RunPodStatusResponse> {
		const id = await this.submitJob(input)
		return this.waitForJob(id)
	}

	getAudio(response: RunPodStatusResponse): Buffer[] {
		if (!response.output) throw new RunPodError("Response has no output")
		const output = response.output
		if (!output.audio || !Array.isArray(output.audio)) throw new RunPodError("Response output missing 'audio' array")
		if (output.audio.length === 0) throw new RunPodError("API returned empty audio array")
		return output.audio.map((b64, i) => {
			if (!b64 || typeof b64 !== "string") throw new RunPodError(`Invalid base64 string at index ${i}`)
			return Buffer.from(b64, "base64")
		})
	}

	async cancelJob(id: string) {
		logToFile(`Canceling job ${id}...`)
		if (!this.activeJobs.has(id)) return
		try {
			await this.endpoint.cancel(id)
			this.activeJobs.delete(id)
			logToFile(`Canceled job ${id}`)
		} catch (err: unknown) {
			logErrorToFile(`Failed to cancel job ${id}`, ensureError(err).message)
		}
	}

	async cancelAll() {
		logToFile(`Canceling all ${this.activeJobs.size} active jobs...`)
		const jobs = Array.from(this.activeJobs)
		if (jobs.length === 0) return
		await Promise.all(jobs.map((id) => this.cancelJob(id)))
	}
}
