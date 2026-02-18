import type { TrackedItem } from "./types"

/**
 * Print a formatted summary table from tracked items.
 *
 * @param items - The tracked items to summarize
 * @param columns - Function that maps each item to column key-value pairs
 */
export function printSummary<T>(
	items: TrackedItem<T>[],
	columns: (item: TrackedItem<T>) => Record<string, string | number | undefined>
): void {
	if (items.length === 0) {
		console.log("\n📊 No items to summarize.")
		return
	}

	// Build rows
	const rows = items.map((item) => {
		const cols = columns(item)
		const row: Record<string, string> = { Status: statusIcon(item.status) }
		for (const [key, val] of Object.entries(cols)) {
			row[key] = val != null ? String(val) : "—"
		}
		return row
	})

	// Calculate column widths
	const allKeys = Object.keys(rows[0]!)
	const widths: Record<string, number> = {}
	for (const key of allKeys) {
		widths[key] = Math.max(key.length, ...rows.map((r) => (r[key] || "—").length))
	}

	// Print
	const sep = "─".repeat(allKeys.reduce((sum, k) => sum + widths[k]! + 3, 0) + 1)

	console.log("\n📊 Summary:")
	console.log(sep)
	console.log(allKeys.map((k) => k.padEnd(widths[k]!)).join("   "))
	console.log(sep)
	for (const row of rows) {
		console.log(allKeys.map((k) => (row[k] || "—").padEnd(widths[k]!)).join("   "))
	}
	console.log(sep)

	// Stats
	const ok = items.filter((i) => i.status === "completed").length
	const failed = items.filter((i) => i.status === "failed").length
	const elapsed = items
		.filter((i) => i.elapsed)
		.map((i) => i.elapsed!)

	const totalTime = elapsed.length > 0 ? Math.max(...elapsed) : 0
	console.log(`\n   ✅ ${ok} completed, ❌ ${failed} failed, ⏱️  ${(totalTime / 1000).toFixed(1)}s total`)
}

function statusIcon(status: string): string {
	switch (status) {
		case "completed": return "✅"
		case "failed": return "❌"
		case "running": return "⏳"
		case "queued": return "📋"
		default: return "❓"
	}
}
