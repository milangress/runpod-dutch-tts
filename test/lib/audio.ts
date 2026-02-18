import { join } from "path"
import type { AudioPrompt } from "./types"

/**
 * Load an audio prompt file and return its base64-encoded content.
 * Path is resolved relative to the test/ directory.
 */
export async function loadAudioPrompt(filePath: string): Promise<AudioPrompt> {
	// Resolve relative to test/ dir
	const resolved = filePath.startsWith("/") ? filePath : join(import.meta.dir, "..", filePath)
	const file = Bun.file(resolved)

	if (!(await file.exists())) {
		throw new Error(`Audio prompt not found: ${resolved}`)
	}

	const bytes = await file.arrayBuffer()
	const base64 = Buffer.from(bytes).toString("base64")
	const sizeKB = (bytes.byteLength / 1024).toFixed(1)
	const { logToFile } = await import("./logger")
	logToFile(`🎤 Audio prompt: ${filePath} (${sizeKB} KB)`)

	return { base64, sizeKB }
}

/**
 * Concatenate multiple WAV buffers into a single WAV file.
 * Assumes all WAVs share the same format (sample rate, channels, bit depth).
 */
export function concatenateWavBuffers(buffers: Buffer[]): Buffer {
	if (buffers.length === 0) throw new Error("No buffers to concatenate")
	if (buffers.length === 1) return buffers[0]!

	// Parse header from first WAV to get format info
	const first = buffers[0]!
	const numChannels = first.readUInt16LE(22)
	const sampleRate = first.readUInt32LE(24)
	const bitsPerSample = first.readUInt16LE(34)
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
	const blockAlign = numChannels * (bitsPerSample / 8)

	// Extract raw PCM data from each WAV (skip 44-byte header)
	const pcmChunks = buffers.map((buf) => buf.subarray(44))
	const totalDataSize = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0)

	// Build new WAV with combined data
	const header = Buffer.alloc(44)
	header.write("RIFF", 0)
	header.writeUInt32LE(36 + totalDataSize, 4)
	header.write("WAVE", 8)
	header.write("fmt ", 12)
	header.writeUInt32LE(16, 16) // fmt chunk size
	header.writeUInt16LE(1, 20) // PCM format
	header.writeUInt16LE(numChannels, 22)
	header.writeUInt32LE(sampleRate, 24)
	header.writeUInt32LE(byteRate, 28)
	header.writeUInt16LE(blockAlign, 32)
	header.writeUInt16LE(bitsPerSample, 34)
	header.write("data", 36)
	header.writeUInt32LE(totalDataSize, 40)

	return Buffer.concat([header, ...pcmChunks])
}

/**
 * Calculate duration of a WAV file in seconds.
 */
export function getWavDuration(buffer: Buffer): number {
	try {
		// WAV header is 44 bytes. Check length and read byteRate at offset 28.
		if (buffer.length < 44) return 0
		const byteRate = buffer.readUInt32LE(28)
		if (byteRate === 0) return 0

		const dataSize = buffer.length - 44
		return dataSize / byteRate
	} catch (err) {
		return 0
	}
}
