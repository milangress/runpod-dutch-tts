
export interface RunPodJobInput {
	text?: string
	texts?: string[]
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
	[key: string]: any
}

export interface RunPodJobOutput {
	audio: string[]
	format: string
	error?: string
	[key: string]: any
}

export type RunPodJobStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT"

export interface RunPodStatusResponse {
	id: string
	status: RunPodJobStatus
	output?: RunPodJobOutput
	error?: string
}
