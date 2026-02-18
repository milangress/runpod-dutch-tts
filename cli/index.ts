import { runTest, writeOutput } from "./lib"

const TEXT = "[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen."

runTest(async (client) => {
	console.log("🎙️  Single TTS request")

	const [result] = await client.runAll(
		[{
			text: TEXT,
			label: "tts_test",
		}],
		{
			params: { max_new_tokens: 3072, guidance_scale: 3.0, temperature: 0, top_p: 0.8, top_k: 30, seed: 30 },
		}
	)

	if (result!.status === "COMPLETED" && result!.audio) {
		const filename = `tts_${Date.now()}.${result!.format}`
		const file = await writeOutput(filename, result!.audio)
		console.log(`✅ Audio saved: ${filename} (${file.sizeKB} KB)`)
	} else {
		console.error(`❌ Failed: ${result!.error?.message}`)
	}
})
