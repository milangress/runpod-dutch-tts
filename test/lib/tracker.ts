import type { Endpoint } from "./client"
import { JobFailedError, RunPodError, ensureError } from "./errors"
import type {
	GenerationParams,
	ItemRequest,
	RunAllOptions,
	RunPodJobInput,
	RunPodStatusResponse,
	TrackedItem,
} from "./types"

const POLL_INTERVAL_MS = 2000
const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/** Internal: a group of items that share the same params → one RunPod job */
interface Batch<T> {
	items: { index: number; request: ItemRequest<T> }[]
	jobInput: RunPodJobInput
}

/**
 * Build a deterministic key from the generation params + voice cloning config.
 * Items with the same key get batched together.
 */
function batchKey<T>(item: ItemRequest<T>, baseParams?: Partial<GenerationParams>): string {
	const merged = { ...baseParams, ...item.params }
	const parts: string[] = [
		`seed:${merged.seed ?? "none"}`,
		`temp:${merged.temperature}`,
		`top_p:${merged.top_p}`,
		`top_k:${merged.top_k}`,
		`guidance:${merged.guidance_scale}`,
		`tokens:${merged.max_new_tokens}`,
		`fmt:${merged.output_format}`,
		`ap:${item.audioPrompt ? "yes" : "no"}`,
		`apt:${item.audioPromptTranscript ?? "none"}`,
	]
	return parts.join("|")
}

/**
 * Group items into batches by matching params, respecting batchSize.
 */
function buildBatches<T>(
	items: ItemRequest<T>[],
	baseParams?: Partial<GenerationParams>,
	batchSize = 3
): Batch<T>[] {
	// Group by param key
	const groups = new Map<string, { index: number; request: ItemRequest<T> }[]>()

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!
		const key = batchKey(item, baseParams)
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key)!.push({ index: i, request: item })
	}

	// Split each group into chunks of batchSize
	const batches: Batch<T>[] = []

	for (const group of groups.values()) {
		for (let i = 0; i < group.length; i += batchSize) {
			const chunk = group.slice(i, i + batchSize)
			const first = chunk[0]!.request
			const mergedParams = { ...baseParams, ...first.params }

			const jobInput: RunPodJobInput = {
				texts: chunk.map((c) => c.request.text),
				max_new_tokens: mergedParams.max_new_tokens,
				guidance_scale: mergedParams.guidance_scale,
				temperature: mergedParams.temperature,
				top_p: mergedParams.top_p,
				top_k: mergedParams.top_k,
				output_format: mergedParams.output_format ?? "wav",
				seed: mergedParams.seed,
			}

			// Voice cloning
			if (first.audioPrompt) {
				jobInput.audio_prompt = first.audioPrompt
				jobInput.audio_prompt_transcript = first.audioPromptTranscript
			}

			batches.push({ items: chunk, jobInput })
		}
	}

	return batches
}

/**
 * Execute all items: auto-batch, submit, poll, track, return results.
 */
export async function executeAll<T>(
	endpoint: Endpoint,
	activeJobs: Set<string>,
	items: ItemRequest<T>[],
	options: RunAllOptions<T> = {}
): Promise<TrackedItem<T>[]> {
	const { params, batchSize = 3, onProgress, onBatchSubmit, onStatusChange, onInit, signal } = options

	const batches = buildBatches(items, params, batchSize)

	const totalItems = items.length
	const totalBatches = batches.length
	// console.log(`\n📦 ${totalItems} item(s) → ${totalBatches} batch(es) (max ${batchSize} per batch)`)

	// Initialize tracked items with batch info
	const tracked: TrackedItem<T>[] = new Array(items.length)

	batches.forEach((batch, batchIdx) => {
		batch.items.forEach(({ index, request }) => {
			tracked[index] = {
				text: request.text,
				label: request.label,
				context: request.context as T,
				status: "queued",
				format: (params?.output_format ?? request.params?.output_format ?? "wav"),
				startedAt: 0,
				batchIndex: batchIdx,
				batchTotal: totalBatches,
			}
		})
	})

	onInit?.(tracked)

	// Submit all batches
	const submittedBatches: { batch: Batch<T>; jobId: string }[] = []
	const now = Date.now()

	for (let b = 0; b < batches.length; b++) {
		const batch = batches[b]!

		if (signal?.aborted) {
			// Mark remaining items as cancelled
			for (const { index } of batch.items) {
				tracked[index]!.status = "cancelled"
				tracked[index]!.error = new Error("Operation aborted")
				tracked[index]!.completedAt = Date.now()
				onStatusChange?.(tracked[index]!)
			}
			continue
		}
		try {
			const result = await endpoint.run({ input: batch.jobInput })
			const jobId = result.id!

			if (!jobId) throw new RunPodError("No job ID returned from RunPod")
			activeJobs.add(jobId)

			// Mark items as running
			for (const { index } of batch.items) {
				tracked[index]!.status = "running"
				tracked[index]!.startedAt = now
				onStatusChange?.(tracked[index]!)
			}

			submittedBatches.push({ batch, jobId })

			// console.log(`   🚀 Batch ${b + 1}/${totalBatches} → ${jobId} [${itemLabels}]`)

			onBatchSubmit?.(jobId, batch.items.length)
		} catch (err: unknown) {
			const error = ensureError(err)
			for (const { index } of batch.items) {
				tracked[index]!.status = "failed"
				tracked[index]!.error = error
				tracked[index]!.completedAt = Date.now()
				tracked[index]!.elapsed = Date.now() - now
				onStatusChange?.(tracked[index]!)
			}
			console.error(`   ❌ Batch ${b + 1} submit failed: ${error.message}`)
		}
	}

	// Poll all submitted batches concurrently
	// console.log(`\n⏳ Polling ${submittedBatches.length} job(s)...`)

	await Promise.all(
		submittedBatches.map(async ({ batch, jobId }) => {
			try {
				const response = await pollJob(endpoint, jobId, TIMEOUT_MS, (status) => {
					for (const { index } of batch.items) {
						tracked[index]!.runpodStatus = status
						onStatusChange?.(tracked[index]!)
					}
				}, signal)
				activeJobs.delete(jobId)

				if (response.status === "CANCELLED" || response.status === "TERMINATED") {
					const completedAt = Date.now()
					for (const { index } of batch.items) {
						tracked[index]!.status = "cancelled"
						tracked[index]!.error = new Error("Job cancelled")
						tracked[index]!.completedAt = completedAt
						tracked[index]!.elapsed = completedAt - tracked[index]!.startedAt
						onStatusChange?.(tracked[index]!)
					}
					return
				}

				const output = response.output
				if (!output || !output.audio || !Array.isArray(output.audio)) {
					throw new RunPodError(`Job ${jobId}: missing audio in response`)
				}

				const completedAt = Date.now()

				for (let j = 0; j < batch.items.length; j++) {
					const { index } = batch.items[j]!
					const item = tracked[index]!
					const b64 = output.audio[j]

					if (!b64 || typeof b64 !== "string") {
						item.status = "failed"
						item.error = new RunPodError(`Empty audio at index ${j}`)
					} else {
						item.status = "completed"
						item.audio = Buffer.from(b64, "base64")
						item.format = output.format || "wav"
					}

					item.completedAt = completedAt
					item.elapsed = completedAt - item.startedAt
					onStatusChange?.(item)

					if (onProgress) await onProgress(item)
				}
			} catch (err: unknown) {
				activeJobs.delete(jobId)
				const error = err instanceof Error ? err : ensureError(err)
				const completedAt = Date.now()

				for (const { index } of batch.items) {
					const item = tracked[index]!
					item.status = "failed"
					item.error = error
					item.completedAt = completedAt
					item.elapsed = completedAt - item.startedAt
					onStatusChange?.(item)
					if (onProgress) await onProgress(item)
				}
			}
		})
	)

	return tracked
}

/**
 * Poll a RunPod job until completion or timeout.
 */
async function pollJob(
	endpoint: Endpoint,
	jobId: string,
	timeoutMs: number,
	onStatusUpdate?: (status: string) => void,
	signal?: AbortSignal
): Promise<RunPodStatusResponse> {
	const start = Date.now()

	while (Date.now() - start < timeoutMs) {
		const status = (await endpoint.status(jobId)) as RunPodStatusResponse
		onStatusUpdate?.(status.status)

		// Check for application-level errors in output
		if (status.output && typeof status.output === "object" && "error" in status.output) {
			throw new JobFailedError(jobId, `Application error: ${status.output.error}`)
		}

		if (status.status === "COMPLETED" || status.status === "CANCELLED" || status.status === "TERMINATED") {
			return status
		}

		if (status.status === "FAILED") {
			throw new JobFailedError(jobId, status.error || "Job failed without error message")
		}

		// Wait with abort support
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, POLL_INTERVAL_MS)
			if (signal) {
				signal.addEventListener("abort", () => {
					clearTimeout(timer)
					resolve()
				}, { once: true })
			}
		})

		if (signal?.aborted) return { id: jobId, status: "CANCELLED" }
	}

	// Timeout — try to cancel
	try {
		await endpoint.cancel(jobId)
	} catch { /* best effort */ }

	throw new RunPodError(`Job ${jobId} timed out after ${timeoutMs}ms`)
}
