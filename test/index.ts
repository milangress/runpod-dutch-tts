
import { runTest, writeOutput } from "./lib"

const input = {
	texts: ["[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen."],
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
	console.log(`   Text: "${input.texts[0]}"`)

	const result = await client.run(input)
	const [audioBuffer] = client.getAudio(result)

	// audioBuffer is guaranteed by getAudio() check
	const format = result.output?.format || "wav"
	const filename = `tts_${Date.now()}.${format}`

	// Write output using helper
	const file = await writeOutput(filename, audioBuffer!)

	const sizeKB = (file.size / 1024).toFixed(1)
	console.log(`✅ Audio saved: ${filename} (${sizeKB} KB). Format: ${format}`)
})
