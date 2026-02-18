import { logToFile } from "./logger"
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
		logToFile("\n📊 No items to summarize.")
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

	logToFile("\n📊 Summary:")
	logToFile(sep)
	logToFile(allKeys.map((k) => k.padEnd(widths[k]!)).join("   "))
	logToFile(sep)
	for (const row of rows) {
		logToFile(allKeys.map((k) => (row[k] || "—").padEnd(widths[k]!)).join("   "))
	}
	logToFile(sep)

	// Stats
	const ok = items.filter((i) => i.status === "COMPLETED").length
	const failed = items.filter((i) => i.status === "FAILED").length
	const elapsed = items
		.filter((i) => i.elapsed != null)
		.map((i) => i.elapsed!)

	const maxElapsed = elapsed.length > 0 ? Math.max(...elapsed) : 0
	logToFile(`\n   ✅ ${ok} completed, ❌ ${failed} failed, ⏱️  ${(maxElapsed / 1000).toFixed(1)}s max`)
}

function statusIcon(status: string): string {
	switch (status) {
		case "COMPLETED": return "✅"
		case "FAILED":
		case "TIMED_OUT": return "❌"
		case "IN_PROGRESS": return "⏳"
		case "PENDING":
		case "SUBMITTED":
		case "IN_QUEUE": return "📋"
		case "CANCELLED":
		case "TERMINATED":
		case "LOCAL_CANCELLED": return "⊘"
		default: return "❓"
	}
}
