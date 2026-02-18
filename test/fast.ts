import { runTest, runWithUI, writeOutput } from "./lib"

/**
 * Fast diagnostic test with small batches.
 * Useful for verifying connectivity and UI without long generation times.
 */
runTest(async (client) => {
	await runWithUI(
		client,
		[
			{ text: "Hallo, dit is een korte test.", label: "test_short", context: "fast_1" },
			{ text: "Dit is de tweede snelle batch.", label: "test_fast", context: "fast_2" },
		],
		{
			batchSize: 1,
			params: { max_new_tokens: 128 },
			onProgress: async (item) => {
				if (item.status === "COMPLETED" && item.audio) {
					const { getWavDuration } = await import("./lib/audio")
					item.audioDuration = getWavDuration(item.audio)
					const out = await writeOutput(`fast/fast_${item.context}.wav`, item.audio)
					item.outputPath = out.path
				}
			},
		}
	)
})
