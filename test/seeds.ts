import { runTest, writeOutput } from "./lib"

const SEEDS = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
const TEXT = "[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen."
const PARAMS = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 0,
	top_p: 0.8,
	top_k: 30,
	output_format: "wav",
}

runTest(async (client) => {
	console.log(`🔬 Seed exploration — ${SEEDS.length} seeds (parallel)`)
	console.log(`   Text: "${TEXT}"`)

	console.log("🚀 Sending requests in parallel...")
	const jobs = await Promise.all(
		SEEDS.map(async (seed) => {
			const id = await client.submitJob({ texts: [TEXT], seed, ...PARAMS })
			console.log(`   Seed ${String(seed).padEnd(6)} → queued (${id})`)
			return { seed, id }
		})
	)

	console.log(`\n⏳ All ${jobs.length} jobs queued, polling for results...\n`)

	const results = await Promise.all(
		jobs.map(async ({ seed, id }) => {
			const start = Date.now()
			try {
				const status = await client.waitForJob(id)
				const elapsed = ((Date.now() - start) / 1000).toFixed(1)

				const audioBuffers = client.getAudio(status)
				const audioBuffer = audioBuffers[0]! // Checked by getAudio()
				const format = status.output?.format || "wav"

				const filename = `seed_${seed}.${format}`

				// Use helper to write output
				const file = await writeOutput(`seeds/${filename}`, audioBuffer)

				const sizeKB = (file.size / 1024).toFixed(1)
				console.log(`   ✅ Seed ${String(seed).padEnd(6)} — ${elapsed}s — ${sizeKB} KB → ${filename}`)
				return { seed, status: "ok", file: filename, size: `${sizeKB} KB`, elapsed: `${elapsed}s` }
			} catch (err: unknown) {
				const elapsed = ((Date.now() - start) / 1000).toFixed(1)
				const message = (err instanceof Error) ? err.message : String(err)
				console.log(`   ❌ Seed ${String(seed).padEnd(6)} — ${elapsed}s — FAILED: ${message}`)
				return { seed, status: "failed", elapsed: `${elapsed}s` }
			}
		})
	)

	console.log("\n\n📊 Summary:")
	console.log("─".repeat(55))
	console.log("Seed".padEnd(10) + "Status".padEnd(12) + "Time".padEnd(10) + "Size".padEnd(12) + "File")
	console.log("─".repeat(55))

	results.sort((a, b) => a.seed - b.seed)
	results.forEach((r) => {
		console.log(
			String(r.seed).padEnd(10) +
			r.status.padEnd(12) +
			(r.elapsed || "—").padEnd(10) +
			(r.size || "—").padEnd(12) +
			(r.file || "—")
		)
	})
	console.log("─".repeat(55))
	console.log(`\n🎧 Listen to the files in: output/seeds`)
})
