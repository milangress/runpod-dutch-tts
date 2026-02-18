
export class RunPodError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RunPodError"
	}
}

export class JobFailedError extends RunPodError {
	constructor(public jobId: string, message: string) {
		super(`Job ${jobId} failed: ${message}`)
		this.name = "JobFailedError"
	}
}

export class JobTimeoutError extends RunPodError {
	constructor(public jobId: string, timeoutMs: number) {
		super(`Job ${jobId} timed out after ${timeoutMs}ms`)
		this.name = "JobTimeoutError"
	}
}

/**
 * Ensures that an unknown error value is converted into a proper Error object.
 * Useful for handling `catch (err: unknown)` blocks safely.
 */
export function ensureError(value: unknown): Error {
	if (value instanceof Error) return value

	let stringified = "[Unable to stringify error]"
	try {
		stringified = typeof value === "string" ? value : JSON.stringify(value)
	} catch {
		stringified = String(value)
	}

	const error = new Error(stringified)
	return error
}
