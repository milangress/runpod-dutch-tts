/**
 * Voice cloning test — batch mode with audio prompt.
 *
 * Sends multiple texts + audio_prompt + audio_prompt_transcript to the handler.
 * The handler prepends the transcript to each text internally.
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

// 4 different texts to generate in the cloned voice (all S1 only, ~5 sentences each)
const TEXTS = [
	"[S1] vandaag wil ik het hebben over kunstmatige intelligentie. het is een fascinerend onderwerp dat steeds meer invloed heeft op ons dagelijks leven. van slimme assistenten tot zelfrijdende auto's, de mogelijkheden zijn eindeloos. maar er zijn ook risico's waar we rekening mee moeten houden. laten we daar eens dieper op ingaan.",

	"[S1] het weer in Nederland is altijd een populair gespreksonderwerp. de ene dag schijnt de zon en is het prachtig buiten. de volgende dag regent het weer pijpenstelen en waait het hard. maar dat maakt ons niet uit, want we hebben altijd een paraplu bij de hand. dat is typisch Nederlands.",

	"[S1] ik ben gisteren naar het museum geweest in Amsterdam. de tentoonstelling over moderne kunst was echt indrukwekkend. er waren schilderijen van kunstenaars uit de hele wereld te zien. het mooiste vond ik een groot abstract werk in felle kleuren. ik raad iedereen aan om er een keer naartoe te gaan.",

	"[S1] koken is een van mijn favoriete hobby's. elke avond probeer ik iets nieuws te maken in de keuken. gisteren heb ik een heerlijke stamppot gemaakt met boerenkool en rookworst. het recept komt van mijn oma en het smaakt altijd fantastisch. de geur van verse kruiden maakt het helemaal af.",
]

const AUDIO_PROMPT_FILE = join(import.meta.dir, "audio-prompt.wav")

const PARAMS = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 1,
	top_p: 0.95,
	top_k: 50,
	output_format: "wav",
	seed: 30,
}
// ───────────────────────────────────────────────────────────────────

const outDir = join(import.meta.dir, "output", "clone")
await mkdir(outDir, { recursive: true })

console.log(`🎤 Voice cloning batch test — ${TEXTS.length} texts`)
console.log(`   Audio prompt: ${AUDIO_PROMPT_FILE}`)
console.log(`   Transcript:   "${AUDIO_PROMPT_TRANSCRIPT}"`)
console.log()
TEXTS.forEach((t, i) => console.log(`   [${i}] "${t.slice(0, 80)}..."`))
console.log()

// Read and base64-encode the audio prompt
const audioBytes = await readFile(AUDIO_PROMPT_FILE)
const audioB64 = audioBytes.toString("base64")
console.log(`   Audio prompt size: ${(audioBytes.byteLength / 1024).toFixed(1)} KB`)

const start = Date.now()

// Send the batch request
console.log("\n🚀 Sending voice cloning batch request...")
const result = await endpoint.run({
	input: {
		texts: TEXTS,
		audio_prompt: audioB64,
		audio_prompt_transcript: AUDIO_PROMPT_TRANSCRIPT,
		...PARAMS,
	},
})

const id = result.id!
console.log(`   Job ID: ${id}`)

// Poll for completion
let done = false
while (!done) {
	const status = (await endpoint.status(id)) as any

	if (status.status === "COMPLETED") {
		done = true
		const elapsed = ((Date.now() - start) / 1000).toFixed(1)
		const output = status.output as any

		if (output.error) {
			console.error(`\n❌ Error: ${output.error}`)
			process.exit(1)
		}

		const audioList: string[] = output.audio
		console.log(`\n✅ Voice cloning batch complete in ${elapsed}s — ${audioList.length} files`)

		for (let i = 0; i < audioList.length; i++) {
			const audioBuffer = Buffer.from(audioList[i]!, "base64")
			const filename = `clone_${i}.${output.format || "wav"}`
			await writeFile(join(outDir, filename), audioBuffer)
			const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1)
			console.log(`   ${filename} — ${sizeKB} KB`)
		}

		console.log(`\n🎧 Files saved to: ${outDir}`)
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
