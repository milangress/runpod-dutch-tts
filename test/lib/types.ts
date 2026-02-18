
// ── RunPod API types ───────────────────────────────────────────────

export interface RunPodJobInput {
	texts: string[]
	audio_prompt?: string // base64
	audio_prompt_transcript?: string
	max_new_tokens?: number
	guidance_scale?: number
	temperature?: number
	top_p?: number
	top_k?: number
	output_format?: string
	seed?: number
	voice?: string
}

export interface RunPodJobOutput {
	audio: string[]
	format: string
	error?: string
}

export type RunPodJobStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "TERMINATED"

export interface RunPodStatusResponse {
	id: string
	status: RunPodJobStatus
	output?: RunPodJobOutput
	error?: string
}

// ── Generation params ──────────────────────────────────────────────

/** Parameters that control TTS generation (everything except text & voice cloning) */
export interface GenerationParams {
	max_new_tokens: number
	guidance_scale: number
	temperature: number
	top_p: number
	top_k: number
	output_format: string
	seed?: number
}

export const DEFAULT_PARAMS: GenerationParams = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 0,
	top_p: 0.8,
	top_k: 30,
	output_format: "wav",
}

// ── Item-level tracking ────────────────────────────────────────────

/** What the user provides — one per text prompt */
export interface ItemRequest<T = void> {
	/** The text to synthesize */
	text: string
	/** Human-readable label (used for display and default filename) */
	label: string
	/** Arbitrary user data attached to results */
	context?: T

	/** Per-item param overrides (merged on top of RunAllOptions.params) */
	params?: Partial<GenerationParams>

	/** Voice cloning: base64-encoded audio prompt */
	audioPrompt?: string
	/** Voice cloning: transcript of the audio prompt */
	audioPromptTranscript?: string
}

/** What the user gets back — one per text prompt, fully resolved */
export interface TrackedItem<T = void> {
	/** The input text */
	text: string
	/** Human-readable label */
	label: string
	/** User-attached context */
	context: T
	/** Current status of the item */
	status: "queued" | "running" | "completed" | "failed" | "cancelled"
	/** Decoded audio buffer (set on completion) */
	audio?: Buffer
	/** Audio format (e.g. "wav") */
	format: string
	/** Timestamp when the job was submitted */
	startedAt: number
	/** Timestamp when the job completed/failed */
	completedAt?: number
	/** Duration in ms */
	elapsed?: number
	/** Error if failed */
	error?: Error

	/** The batch index this item belongs to (0-based) */
	batchIndex?: number
	/** Total number of batches */
	batchTotal?: number

	/** Raw status from RunPod (e.g. "IN_QUEUE", "IN_PROGRESS", "COMPLETED") */
	runpodStatus?: string
}

/** Options for client.runAll() */
export interface RunAllOptions<T = void> {
	/** Default generation params (item-level params override these) */
	params?: Partial<GenerationParams>

	/** How many texts to send per RunPod job (default: 3) */
	batchSize?: number

	/** Called when an individual item completes (success or failure) */
	onProgress?: (item: TrackedItem<T>) => void | Promise<void>

	/** Called when a batch job is submitted */
	onBatchSubmit?: (jobId: string, itemCount: number) => void

	/** Output directory relative to test/output/ — enables auto-save */
	outputDir?: string

	/** Custom filename function (default: `${item.label}.${item.format}`) */
	filename?: (item: TrackedItem<T>) => string

	/** Called whenever an item's status changes (queued → running → completed/failed) */
	onStatusChange?: (item: TrackedItem<T>) => void

	/** Called with the full array of tracked items immediately after initialization */
	onInit?: (items: TrackedItem<T>[]) => void
}

/** Result of loading an audio prompt file */
export interface AudioPrompt {
	base64: string
	sizeKB: string
}
