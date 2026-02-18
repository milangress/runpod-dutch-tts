import { runTest, runWithUI, writeOutput } from "./lib"

const SEEDS = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
const TEXT = "[S1] hallo, hoe gaat het met je vandaag? het gaat goed, dankjewel. en met jou? ook goed, dankjewel voor het vragen."

runTest(async (client) => {
	await runWithUI(
		client,
		SEEDS.map((seed) => ({
			text: TEXT,
			label: `seed_${seed}`,
			context: seed,
			params: { seed },
		})),
		{
			params: { max_new_tokens: 3072, guidance_scale: 3.0, temperature: 0, top_p: 0.8, top_k: 30 },
			onProgress: async (item) => {
				if (item.status === "COMPLETED" && item.audio) {
					await writeOutput(`seeds/seed_${item.context}.${item.format}`, item.audio)
				}
			},
		}
	)
})
