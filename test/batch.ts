
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import { runTest } from "./lib"

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

runTest(async (client) => {
	const outDir = join(import.meta.dir, "output", "batch")
	await mkdir(outDir, { recursive: true })

	console.log(`📦 Batch TTS — ${TEXTS.length} texts in one request`)
	TEXTS.forEach((t, i) => console.log(`   [${i}] "${t}"`))
	console.log()

	console.log("🚀 Sending batch request...")
	const result = await client.run({
		texts: TEXTS,
		...PARAMS,
	})

	const output = result.output
	if (!output) throw new Error("No output in result")

	const audioList = output.audio || []
	console.log(`\n✅ Batch complete — ${audioList.length} audio files`)

	for (let i = 0; i < audioList.length; i++) {
		const audioBuffer = Buffer.from(audioList[i], "base64")
		const filename = `batch_${i}.${output.format || "wav"}`
		await writeFile(join(outDir, filename), audioBuffer)
		const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1)
		console.log(`   ${filename} — ${sizeKB} KB`)
	}

	console.log(`\n🎧 Files saved to: ${outDir}`)
})
