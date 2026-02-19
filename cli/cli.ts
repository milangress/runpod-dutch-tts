import { exists, mkdir, readdir, readFile } from "fs/promises"
import { basename, join } from "path"
import {
	concatenateWavBuffers,
	loadAudioPrompt,
	runTest,
	runWithUI,
	writeOutput,
	type ItemRequest,
	type TrackedItem,
} from "./lib"

// ── Configuration ──────────────────────────────────────────────────

const STORIES_DIR = join(import.meta.dir, "..", "stories")
const AUDIO_DIR = join(import.meta.dir, "..", "audio")
const AUDIO_PROMPT_FILE = "audio-prompt.wav" // Relative to test/ or wherever loadAudioPrompt expects

/** Max characters per chunk — keeps generation under max_new_tokens limit */
const BATCH_CHAR_LIMIT = 200

/** Transcript of the audio prompt file */
const AUDIO_PROMPT_TRANSCRIPT =
	`[S1] Dit is een test verhaal. Het is kort en bedoeld om te kijken of het script werkt. We kijken of het geheugen goed blijft en de audio goed klinkt.`

// ── Markdown Parsing ───────────────────────────────────────────────

function extractTextFromMarkdown(content: string): string[] {
	const lines = content.split("\n")
	const paragraphs: string[] = []
	let inFrontmatter = false
	let pastFrontmatter = false

	for (const line of lines) {
		const trimmed = line.trim()
		if (trimmed === "---") {
			if (!pastFrontmatter) {
				inFrontmatter = !inFrontmatter
				if (!inFrontmatter) pastFrontmatter = true
				continue
			}
			if (paragraphs.length > 0) break
			continue
		}
		if (inFrontmatter) continue
		if (/^##\s+(Vocabulaire|Vocabulary|Grammar|Reflection)/i.test(trimmed)) break
		if (trimmed.startsWith("#")) continue
		if (trimmed) paragraphs.push(trimmed)
	}
	return paragraphs
}

function chunkText(paragraphs: string[], charLimit = BATCH_CHAR_LIMIT): string[] {
	const chunks: string[] = []
	let current: string[] = []
	let currentLen = 0

	for (const para of paragraphs) {
		if (currentLen + para.length > charLimit && current.length > 0) {
			chunks.push("[S1] " + current.join(" "))
			current = [para]
			currentLen = para.length
		} else {
			current.push(para)
			currentLen += para.length
		}
	}
	if (current.length > 0) {
		chunks.push("[S1] " + current.join(" "))
	}
	return chunks
}

// ── Main ───────────────────────────────────────────────────────────

const chunkedMode = process.argv.includes("--chunked")

runTest(async (client) => {
	console.log("🚀 Starting Story Generator...")

	// Ensure directories
	await mkdir(AUDIO_DIR, { recursive: true })

	// Load audio prompt
	const audioPrompt = await loadAudioPrompt(AUDIO_PROMPT_FILE)

	// Find stories
	const files = await readdir(STORIES_DIR)
	const storyFiles = files.filter((f) => f.endsWith(".md")).sort()

	console.log(`📚 Found ${storyFiles.length} stories`)

	const params = {
		max_new_tokens: 3072,
		guidance_scale: 3.0,
		temperature: 1.5,
		top_p: 0.95,
		top_k: 50,
		output_format: "wav",
	}

	const itemsToRun: ItemRequest[] = []
	const storyMap = new Map<string, { chunks: number, outputBytes: Buffer[] }>()

	for (const file of storyFiles) {
		const storyName = basename(file, ".md")
		const finalPath = join(AUDIO_DIR, `${storyName}.wav`)

		// Check exists
		if (await exists(finalPath) && !chunkedMode) {
			console.log(`⏭️  ${file} (skipped - target audio exists)`)
			continue
		}

		console.log(`📖 Preparing ${file}...`)
		const content = await readFile(join(STORIES_DIR, file), "utf-8")
		const chunks = chunkText(extractTextFromMarkdown(content))

		if (chunks.length === 0) {
			console.log(`   ⚠️  No content found in ${file}`)
			continue
		}

		storyMap.set(storyName, { chunks: chunks.length, outputBytes: new Array(chunks.length) })

		chunks.forEach((text, i) => {
			itemsToRun.push({
				text,
				label: `chunk_${String(i).padStart(2, "0")}`,
				group: file, // This groups items in the UI
				context: { storyName, index: i },
				audioPrompt: audioPrompt.base64,
				audioPromptTranscript: AUDIO_PROMPT_TRANSCRIPT,
				params,
			})
		})
	}

	if (itemsToRun.length === 0) {
		console.log("✨ Nothing to generate!")
		return
	}

	// Run everything
	await runWithUI(client, itemsToRun, {
		maxConcurrentBatches: 1, // Sequential processing
		onProgress: async (item: TrackedItem<{ storyName: string; index: number }>) => {
			if (item.status === "COMPLETED" && item.audio) {
				const { storyName, index } = item.context

				// Save individual chunk
				const chunkFilename = `${storyName}/chunk_${String(index).padStart(2, "0")}.${item.format}`
				const out = await writeOutput(chunkFilename, item.audio)
				item.outputPath = out.path

				// Store for merging
				const storyData = storyMap.get(storyName)
				if (storyData) {
					storyData.outputBytes[index] = item.audio
				}
			}
		},
	})

	// Post-processing: Merge
	if (!chunkedMode) {
		console.log("\n🔗 Merging files...")
		for (const [storyName, data] of storyMap.entries()) {
			// Check if we have all chunks
			const valid = data.outputBytes.filter(b => b)
			if (valid.length !== data.chunks) {
				// Don't log error here because runWithUI already showed errors
				continue
			}

			// We only merge if we actually generated something or filled the array
			if (valid.length > 0) {
				try {
					const combined = concatenateWavBuffers(valid as Buffer[])
					const out = await writeOutput(`${storyName}.wav`, combined)
					console.log(`   💾 Merged ${storyName}.wav (${out.sizeKB} KB)`)
				} catch (err: any) {
					console.error(`   ❌ Failed to merge ${storyName}: ${err.message}`)
				}
			}
		}
	}
})
