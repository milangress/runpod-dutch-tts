
import { z } from "zod"

const envSchema = z.object({
	RUNPOD_API_KEY: z.string().min(1, "RUNPOD_API_KEY is required"),
	ENDPOINT_ID: z.string().min(1, "ENDPOINT_ID is required"),
})

export function loadConfig() {
	const result = envSchema.safeParse(process.env)

	if (!result.success) {
		console.error("Invalid environment variables:", result.error.format())
		process.exit(1)
	}

	return result.data
}
