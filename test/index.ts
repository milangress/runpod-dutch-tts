
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
	const output = result.output

	if (!output) throw new Error("No output in result")

	if (!output.audio || output.audio.length === 0) {
		throw new Error("No audio in response")
	}

	const audioString = output.audio[0]
	if (!audioString) throw new Error("Audio content missing")

	const audioBuffer = Buffer.from(audioString, "base64")
	const filename = `tts_${Date.now()}.${output.format || "wav"}`

	// Write output using helper
	await writeOutput(filename, audioBuffer)

	console.log(`✅ Audio saved. Format: ${output.format}`)
})
