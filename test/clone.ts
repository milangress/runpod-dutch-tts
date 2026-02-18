/**
 * Voice cloning test — uses an audio prompt to clone a voice.
 *
 * The text must include the transcript of the audio prompt FIRST,
 * followed by the new text you want generated in that voice.
 *
 * Usage:
 *   cd test && bun run clone
 */

import { mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import runpodSdk from "runpod-sdk"

const { RUNPOD_API_KEY, ENDPOINT_ID } = process.env

if (!RUNPOD_API_KEY || !ENDPOINT_ID) {
	console.error("Missing RUNPOD_API_KEY or ENDPOINT_ID in environment.")
	process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const runpod = runpodSdk(RUNPOD_API_KEY)
const endpoint = runpod.endpoint(ENDPOINT_ID)!

// ── Configuration ──────────────────────────────────────────────────

// Transcript of the audio prompt file (must match what's spoken in the audio)
const AUDIO_PROMPT_TRANSCRIPT =
	"[S1] denk je dat je een open source model kan trainen met weinig geld en middelen? " +
	"[S2] ja ik denk het wel. " +
	"[S1] oh ja, hoe dan? " +
	"[S2] nou kijk maar in de repo op Git Hub of Hugging Face."

// New text to generate in the cloned voice (appended to the transcript)
const NEW_TEXT =
	" [S1] dat klinkt interessant, ik ga het zeker proberen. " +
	"[S2] ja doe dat, het is echt heel makkelijk."

// Full text = transcript + new text (the model continues from where the audio ends)
const FULL_TEXT = AUDIO_PROMPT_TRANSCRIPT + NEW_TEXT

const AUDIO_PROMPT_FILE = join(import.meta.dir, "audio-prompt.mp3")

const PARAMS = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 0,
	top_p: 0.8,
	top_k: 30,
	output_format: "wav",
	seed: 30,
}
// ───────────────────────────────────────────────────────────────────

const outDir = join(import.meta.dir, "output", "clone")
await mkdir(outDir, { recursive: true })

console.log("🎤 Voice cloning test")
console.log(`   Audio prompt: ${AUDIO_PROMPT_FILE}`)
console.log(`   Transcript:   "${AUDIO_PROMPT_TRANSCRIPT}"`)
console.log(`   New text:     "${NEW_TEXT}"`)
console.log()

// Read and base64-encode the audio prompt
const audioBytes = await readFile(AUDIO_PROMPT_FILE)
const audioB64 = audioBytes.toString("base64")
console.log(`   Audio prompt size: ${(audioBytes.byteLength / 1024).toFixed(1)} KB`)

const start = Date.now()

// Send the request
console.log("\n🚀 Sending voice cloning request...")
const result = await endpoint.run({
	input: {
		text: FULL_TEXT,
		audio_prompt: audioB64,
		...PARAMS,
	},
})

const id = result.id!
console.log(`   Job ID: ${id}`)

// Poll for completion
let done = false
while (!done) {
	const status = await endpoint.status(id)

	if (status.status === "COMPLETED") {
		done = true
		const elapsed = ((Date.now() - start) / 1000).toFixed(1)
		const output = status.output as any

		if (output.error) {
			console.error(`\n❌ Error: ${output.error}`)
			process.exit(1)
		}

		const audioBuffer = Buffer.from(output.audio, "base64")
		const filename = `clone_output.${output.format || "wav"}`
		await writeFile(join(outDir, filename), audioBuffer)
		const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1)

		console.log(`\n✅ Voice cloning complete in ${elapsed}s`)
		console.log(`   ${filename} — ${sizeKB} KB`)
		console.log(`\n🎧 File saved to: ${join(outDir, filename)}`)
	} else if (status.status === "FAILED") {
		done = true
		const st = status as any
		console.error(`\n❌ Job failed:`, st.error || status)
		process.exit(1)
	} else {
		process.stdout.write(`   ⏳ ${status.status}...\r`)
		await sleep(3000)
	}
}
