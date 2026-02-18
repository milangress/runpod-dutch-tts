
import { ensureDir, outDir, runTest } from "./lib"

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
	console.log("🎙️  Sending TTS request...")
	console.log(`   Text: "${input.text}"`)

	const result = await client.run(input)
	const output = result.output

	if (!output) throw new Error("No output in result")

	if (!output.audio || output.audio.length === 0) {
		throw new Error("No audio in response")
	}

	const audioString = output.audio[0]
	if (!audioString) throw new Error("Audio content missing")

	const audioBuffer = Buffer.from(audioString, "base64")
	const filename = `tts_${Date.now()}.${output.format || "wav"}`

	// Use helper to get the output file reference
	// Subpath relative to test/output/
	const file = outDir(filename)

	// Ensure the directory exists (test/output/)
	await ensureDir(file.name!)

	// Write using Bun.write
	await Bun.write(file, audioBuffer)

	console.log(`✅ Audio saved to: ${file.name}`)
	console.log(`   Format: ${output.format}`)
	console.log(`   Size: ${(audioBuffer.byteLength / 1024).toFixed(1)} KB`)
})
