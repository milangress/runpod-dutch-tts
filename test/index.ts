/**
 * Test script for the RunPod Dutch TTS (Parkiet) endpoint.
 *
 * Usage:
 *   cd test && bun install && bun run index.ts
 *
 * Requires .env in the repo root with:
 *   RUNPOD_API_KEY=your_key
 *   ENDPOINT_ID=your_endpoint_id
 */

import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import runpodSdk from "runpod-sdk"

const { RUNPOD_API_KEY, ENDPOINT_ID } = process.env

if (!RUNPOD_API_KEY || !ENDPOINT_ID) {
	console.error("Missing RUNPOD_API_KEY or ENDPOINT_ID in environment.")
	console.error("Make sure ../.env contains both variables.")
	process.exit(1)
}

const runpod = runpodSdk(RUNPOD_API_KEY)
const endpoint = runpod.endpoint(ENDPOINT_ID)

const input = {
	input: {
		text: "[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen.",
		max_new_tokens: 3072,
		guidance_scale: 3.0,
		temperature: 0, // makes it (together with seed) deterministic
		top_p: 0.8,
		top_k: 30,
		output_format: "wav",
		seed: 30,
	},
}

console.log("🎙️  Sending TTS request to RunPod...")
console.log(`   Endpoint: ${ENDPOINT_ID}`)
console.log(`   Text: "${input.input.text}"`)
console.log()

try {
	if (!endpoint) {
		console.error("❌ No endpoint found.")
		process.exit(1)
	}
	const result = await endpoint.runSync(input)

	if (result.status === "COMPLETED") {
		if (!result.output) {
			console.error("❌ No output in result")
			process.exit(1)
		}
		const output = result.output

		if (output.error) {
			console.error("❌ Handler returned an error:", output.error)
			process.exit(1)
		}

		if (!output.audio) {
			console.error("❌ No audio in response:", JSON.stringify(output, null, 2))
			process.exit(1)
		}

		// Decode base64 audio and save to file
		const audioBuffer = Buffer.from(output.audio, "base64")
		const outDir = join(import.meta.dir, "output")
		await mkdir(outDir, { recursive: true })

		const filename = `tts_${Date.now()}.${output.format || "wav"}`
		const filepath = join(outDir, filename)

		await writeFile(filepath, audioBuffer)

		console.log(`✅ Audio saved to: ${filepath}`)
		console.log(`   Format: ${output.format}`)
		console.log(`   Size: ${(audioBuffer.byteLength / 1024).toFixed(1)} KB`)
	} else {
		console.error(`❌ Job did not complete successfully. Status: ${result.status}`)
		console.error(JSON.stringify(result, null, 2))
		process.exit(1)
	}
} catch (err) {
	console.error("❌ Request failed:", err)
	process.exit(1)
}
