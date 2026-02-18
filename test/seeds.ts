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

interface RunPodStatusResponse {
	id: string
	status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED"
	output?: {
		audio: string[]
		format: string
		error?: string
	}
	error?: string
}

const { RUNPOD_API_KEY, ENDPOINT_ID } = process.env

if (!RUNPOD_API_KEY || !ENDPOINT_ID) {
	console.error("Missing RUNPOD_API_KEY or ENDPOINT_ID in environment.")
	process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const runpod = runpodSdk(RUNPOD_API_KEY)
const endpoint = runpod.endpoint(ENDPOINT_ID)
if (!endpoint) {
	console.error(`Missing endpoint for ID: ${ENDPOINT_ID}`)
	process.exit(1)
}

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

// 1. Fire all jobs in parallel
type Job = { seed: number; id: string; startTime: number }
const jobs: Job[] = []

console.log("🚀 Sending requests in parallel...")

const submissionPromises = SEEDS.map(async (seed) => {
	try {
		const result = await endpoint.run({ input: { text: TEXT, seed, ...PARAMS } })
		const id = result.id
		if (!id) {
			console.error(`❌ Seed ${seed}: Missing job ID in result`)
			return null
		}
		console.log(`   Seed ${String(seed).padEnd(6)} → queued (${id})`)
		return { seed, id, startTime: Date.now() }
	} catch (err: any) {
		console.error(`❌ Seed ${seed}: Failed to submit job`, err.message || err)
		return null
	}
})

const resultsRaw = await Promise.all(submissionPromises)
resultsRaw.forEach((j) => {
	if (j) jobs.push(j)
})

console.log(`\n⏳ All ${jobs.length} jobs queued, polling for results...\n`)

// 2. Poll until all are done
type Result = { seed: number; status: string; file?: string; size?: string; elapsed?: string }
const results: Result[] = []
const pending = new Set(jobs.map((j) => j.seed))

const failureCounts = new Map<number, number>()
const MAX_FAILURES = 3

while (pending.size > 0) {
	for (const job of jobs) {
		if (!pending.has(job.seed)) continue

		try {
			const status = (await endpoint.status(job.id)) as RunPodStatusResponse
			failureCounts.set(job.seed, 0) // Reset failure count on success

			if (status.status === "COMPLETED") {
				pending.delete(job.seed)
				const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1)

				const audioContent = status.output?.audio?.[0]
				if (audioContent) {
					const audioBuffer = Buffer.from(audioContent, "base64")
					const filename = `seed_${job.seed}.${status.output?.format || "wav"}`
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
				console.log(`   ❌ Seed ${String(job.seed).padEnd(6)} — ${elapsed}s — FAILED: ${status.error}`)
				results.push({ seed: job.seed, status: "failed", elapsed: `${elapsed}s` })
			}
			// else still IN_QUEUE or IN_PROGRESS — keep polling
		} catch (err: any) {
			const count = (failureCounts.get(job.seed) || 0) + 1
			failureCounts.set(job.seed, count)

			if (count >= MAX_FAILURES) {
				console.error(`   ⚠️ Seed ${job.seed}: Status check failed ${count} times consecutively. Error:`, err.message || err)
				// Optionally we could remove it from pending if we want to give up,
				// but for now we just log loudly.
			}
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
