import { Box, render, Text } from "ink"
import Spinner from "ink-spinner"
import { useEffect, useState } from "react"
import type { RunPodClient } from "./client"
import type { ItemRequest, RunAllOptions, TrackedItem } from "./types"

// ── Components ─────────────────────────────────────────────────────

const ItemRow = ({ item }: { item: TrackedItem<any> }) => {
	const statusColor =
		item.status === "completed" ? "green" :
		item.status === "failed" ? "red" :
		item.status === "running" ? "cyan" :
		"gray"

	const icon =
		item.status === "completed" ? "✔" :
		item.status === "failed" ? "✖" :
		item.status === "running" ? <Spinner type="dots" /> :
		"•"

	const label = <Text color={statusColor} bold={item.status === "running"}>{item.label}</Text>

	// Snippet of text
	const snippet = item.text.replace(/\s+/g, " ").slice(0, 60) + (item.text.length > 60 ? "..." : "")

	return (
		<Box flexDirection="column" marginLeft={2}>
			<Box>
				<Text color={statusColor}>{icon} </Text>
				{label}
				{item.status === "completed" && item.audio && (
					<Text color="dim">  → {(item.audio.length / 1024).toFixed(1)}kb</Text>
				)}
				{item.status === "failed" && item.error && (
					<Text color="red">  → {item.error.message}</Text>
				)}
			</Box>
			{/* Show text snippet for running/finished/failed */}
			{item.status !== "queued" && (
				<Box marginLeft={2}>
					<Text color="dim">→ "{snippet}"</Text>
				</Box>
			)}
		</Box>
	)
}

const BatchGroup = ({ index, total, items }: { index: number, total: number, items: TrackedItem<any>[] }) => {
	const isFailed = items.some((i) => i.status === "failed")
	const isCompleted = items.every((i) => i.status === "completed")
	const isQueued = items.every((i) => i.status === "queued")

	// Check if this batch is effectively running (submitted to RunPod)
	const isSubmitted = items.some((i) => i.status === "running")
	const isRunning = isSubmitted && !isFailed && !isCompleted

	// Determine specific RunPod status (shared by items in batch)
	const rawStatus = isRunning ? items.find((i) => i.runpodStatus)?.runpodStatus : undefined

	// Expansion logic: Only expand if IN_PROGRESS, COMPLETED, or FAILED
	const showItems = isFailed || isCompleted || (isRunning && rawStatus === "IN_PROGRESS")

	// Header Logic
	let icon: any = "•"
	let color = "gray"
	let statusText = isQueued ? "queued" : isCompleted ? "done" : isFailed ? "failed" : "queued" // Default to queued if running but no status

	if (isRunning) {
		// If we have a raw status, use it
		if (rawStatus) {
			statusText = rawStatus
			if (rawStatus === "IN_QUEUE") {
				color = "magenta"
				icon = <Spinner type="dots" />
			} else if (rawStatus === "IN_PROGRESS") {
				color = "cyan"
				icon = <Spinner type="dots" />
			}
		} else {
			// Submitted but no poll result yet
			statusText = "queued"
			color = "magenta"
			icon = <Spinner type="dots" />
		}
	} else if (isFailed) {
		icon = "✖"
		color = "red"
	} else if (isCompleted) {
		icon = "✔"
		color = "green"
	}

	const elapsed = items.reduce((max, i) => Math.max(max, i.elapsed || 0), 0)
	const duration = elapsed > 0 ? `  ++ took ${(elapsed / 1000).toFixed(1)} s` : ""

	return (
		<Box flexDirection="column">
			<Box>
				<Text color={color}>{icon} </Text>
				<Text bold color={color}>Batch {index + 1}/{total}</Text>
				<Text color="dim"> [{statusText}]</Text>
				{isCompleted && <Text color="dim">{duration}</Text>}
			</Box>

			{showItems && (
				<Box flexDirection="column">
					{items.map((item, i) => (
						<ItemRow key={i} item={item} />
					))}
				</Box>
			)}
		</Box>
	)
}

const ProgressUI = ({ items, error }: { items: TrackedItem<any>[], error?: Error }) => {
	// Group items by batch index
	const batches = new Map<number, TrackedItem<any>[]>()

	items.forEach(item => {
		const idx = item.batchIndex ?? 0
		if (!batches.has(idx)) batches.set(idx, [])
		batches.get(idx)!.push(item)
	})

	const sortedBatches = Array.from(batches.entries()).sort((a, b) => a[0] - b[0])
	const totalBatches = items.length > 0 ? (items[0]?.batchTotal ?? sortedBatches.length) : 0

	// Stats
	const completed = items.filter(i => i.status === "completed").length
	const failed = items.filter(i => i.status === "failed").length
	const total = items.length

	return (
		<Box flexDirection="column" padding={1}>
			{sortedBatches.map(([idx, batchItems]) => (
				<BatchGroup key={idx} index={idx} total={totalBatches} items={batchItems} />
			))}

			<Box marginTop={1} borderStyle="round" borderColor={failed > 0 ? "red" : completed === total ? "green" : "gray"} paddingX={1}>
				<Text>
					Total: {total}  |
					<Text color="green"> ✔ {completed}</Text>  |
					<Text color="red"> ✖ {failed}</Text>
				</Text>
			</Box>

			{error && (
				<Box marginTop={1}>
					<Text color="red" bold>Error: {error.message}</Text>
				</Box>
			)}
		</Box>
	)
}

// ── Wrapper ────────────────────────────────────────────────────────

export async function runWithUI<T>(
	client: RunPodClient,
	items: ItemRequest<T>[],
	options: RunAllOptions<T> = {}
): Promise<TrackedItem<T>[]> {
	return new Promise((resolve, reject) => {
		const Wrapper = () => {
			const [trackedItems, setTrackedItems] = useState<TrackedItem<T>[]>([])
			const [error, setError] = useState<Error>()

			useEffect(() => {
				let mounted = true

				client.runAll(items, {
					...options,
					onInit: (initItems) => {
						if (mounted) setTrackedItems([...initItems])
					},
					onStatusChange: (item) => {
						if (!mounted) return
						// Force update
						setTrackedItems((prev) => [...prev])
					},
				}).then((final) => {
					if (!mounted) return
					setTrackedItems([...final])
					setTimeout(() => {
                        resolve(final)
                    }, 500)
				}).catch((err) => {
					if (mounted) setError(err)
					reject(err)
				})

				return () => { mounted = false }
			}, [])

			return <ProgressUI items={trackedItems} error={error} />
		}

		const { unmount } = render(<Wrapper />)
	})
}
