
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"
import { runTest } from "./lib"

const input = {
	text: "[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen.",
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 0,
	top_p: 0.8,
	top_k: 30,
	output_format: "wav",
	seed: 30,
}

runTest(async (client) => {
	const outDir = join(import.meta.dir, "output")
	await mkdir(outDir, { recursive: true })

	console.log("🎙️  Sending TTS request...")
	console.log(`   Text: "${input.text}"`)

	const result = await client.run(input)
	const output = result.output

	if (!output) throw new Error("No output in result")

	if (!output.audio || output.audio.length === 0) {
		throw new Error("No audio in response")
	}

	const audioBuffer = Buffer.from(output.audio[0], "base64")
	const filename = `tts_${Date.now()}.${output.format || "wav"}`
	const filepath = join(outDir, filename)

	await writeFile(filepath, audioBuffer)

	console.log(`✅ Audio saved to: ${filepath}`)
	console.log(`   Format: ${output.format}`)
	console.log(`   Size: ${(audioBuffer.byteLength / 1024).toFixed(1)} KB`)
})
