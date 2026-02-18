/**
 * Batch TTS test — sends multiple texts in a single request.
 *
 * Usage:
 *   cd test && bun run batch
 */

import { mkdir, writeFile } from "fs/promises"
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
const TEXTS = [
	"[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen.",
	"[S1] het weer is vandaag prachtig in Amsterdam. de zon schijnt en de lucht is blauw. de temperatuur is ongeveer twintig graden Celsius, wat perfect is voor een wandeling door het park.",
	"[S1] wil je een kopje koffie? Het is een beetje koud buiten, dus een warme kop koffie zou lekker zijn. Ik neem wel een cappuccino met havermelk alsjeblieft.",
]
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

const outDir = join(import.meta.dir, "output", "batch")
await mkdir(outDir, { recursive: true })

console.log(`📦 Batch TTS — ${TEXTS.length} texts in one request`)
TEXTS.forEach((t, i) => console.log(`   [${i}] "${t}"`))
console.log()

const start = Date.now()

// Fire the batch request
console.log("🚀 Sending batch request...")
const result = await endpoint.run({
	input: { texts: TEXTS, ...PARAMS },
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
		const output = status.output

		if (output.error) {
			console.error(`\n❌ Error: ${output.error}`)
			process.exit(1)
		}

		const audioList: string[] = output.audio
		console.log(`\n✅ Batch complete in ${elapsed}s — ${audioList.length} audio files`)

		for (let i = 0; i < audioList.length; i++) {
			const audioBuffer = Buffer.from(audioList[i], "base64")
			const filename = `batch_${i}.${output.format || "wav"}`
			await writeFile(join(outDir, filename), audioBuffer)
			const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1)
			console.log(`   ${filename} — ${sizeKB} KB`)
		}

		console.log(`\n🎧 Files saved to: ${outDir}`)
	} else if (status.status === "FAILED") {
		done = true
		console.error(`\n❌ Job failed:`, status.error || status)
		process.exit(1)
	} else {
		process.stdout.write(`   ⏳ ${status.status}...\r`)
		await sleep(3000)
	}
}
