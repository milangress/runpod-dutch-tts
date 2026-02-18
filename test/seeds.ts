/**
 * Seed exploration script — fires all seeds in parallel and lets
 * RunPod batch-process them concurrently.
 *
 * Usage:
 *   cd test && bun run seeds
 */

import { mkdir, writeFile } from "fs/promises"
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
const POLL_INTERVAL = 3000 // ms between status checks
// ───────────────────────────────────────────────────────────────────

const outDir = join(import.meta.dir, "output", "seeds")
await mkdir(outDir, { recursive: true })

console.log(`🔬 Seed exploration — ${SEEDS.length} seeds (parallel)`)
console.log(`   Text: "${TEXT}"`)
console.log(`   Output: ${outDir}`)
console.log()

// 1. Fire all jobs at once
type Job = { seed: number; id: string; startTime: number }
const jobs: Job[] = []

for (const seed of SEEDS) {
	const result = await endpoint.run({ input: { text: TEXT, seed, ...PARAMS } })
	const id = result.id!
	jobs.push({ seed, id, startTime: Date.now() })
	console.log(`🚀 Seed ${String(seed).padEnd(6)} → queued (${id})`)
}

console.log(`\n⏳ All ${jobs.length} jobs queued, polling for results...\n`)

// 2. Poll until all are done
type Result = { seed: number; status: string; file?: string; size?: string; elapsed?: string }
const results: Result[] = []
const pending = new Set(jobs.map((j) => j.seed))

while (pending.size > 0) {
	for (const job of jobs) {
		if (!pending.has(job.seed)) continue

		try {
			const status = await endpoint.status(job.id)

			if (status.status === "COMPLETED") {
				pending.delete(job.seed)
				const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1)

				if (status.output?.audio) {
					const audioBuffer = Buffer.from(status.output.audio, "base64")
					const filename = `seed_${job.seed}.${status.output.format || "wav"}`
					await writeFile(join(outDir, filename), audioBuffer)
					const sizeKB = (audioBuffer.byteLength / 1024).toFixed(1)
					console.log(`   ✅ Seed ${String(job.seed).padEnd(6)} — ${elapsed}s — ${sizeKB} KB → ${filename}`)
					results.push({ seed: job.seed, status: "ok", file: filename, size: `${sizeKB} KB`, elapsed: `${elapsed}s` })
				} else {
					console.log(`   ❌ Seed ${String(job.seed).padEnd(6)} — ${elapsed}s — no audio`)
					results.push({ seed: job.seed, status: "no audio", elapsed: `${elapsed}s` })
				}
			} else if (status.status === "FAILED") {
				pending.delete(job.seed)
				const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1)
				console.log(`   ❌ Seed ${String(job.seed).padEnd(6)} — ${elapsed}s — FAILED`)
				results.push({ seed: job.seed, status: "failed", elapsed: `${elapsed}s` })
			}
			// else still IN_QUEUE or IN_PROGRESS — keep polling
		} catch {
			// transient error, keep polling
		}
	}

	if (pending.size > 0) {
		process.stdout.write(`   ⏳ ${pending.size} remaining: [${[...pending].join(", ")}]\r`)
		await sleep(POLL_INTERVAL)
	}
}

// 3. Summary
results.sort((a, b) => a.seed - b.seed)
console.log("\n\n📊 Summary:")
console.log("─".repeat(55))
console.log("Seed".padEnd(10) + "Status".padEnd(12) + "Time".padEnd(10) + "Size".padEnd(12) + "File")
console.log("─".repeat(55))
for (const r of results) {
	console.log(
		String(r.seed).padEnd(10) +
		r.status.padEnd(12) +
		(r.elapsed || "—").padEnd(10) +
		(r.size || "—").padEnd(12) +
		(r.file || "—")
	)
}
console.log("─".repeat(55))
console.log(`\n🎧 Listen to the files in: ${outDir}`)
