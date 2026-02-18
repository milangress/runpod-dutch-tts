import { Box, render, Static, Text, useInput } from "ink"
import Spinner from "ink-spinner"
import { useEffect, useMemo, useState } from "react"
import type { RunPodClient } from "./client"
import type { ItemRequest, RunAllOptions, TrackedItem } from "./types"

// ── Components ─────────────────────────────────────────────────────

const ItemRow = ({ item, isParentFinal }: { item: TrackedItem<any>, isParentFinal: boolean }) => {
	const status = item.status
	const isCompleted = status === "COMPLETED"
	const isFailed = status === "FAILED" || status === "TIMED_OUT"
	const isCancelled = status === "CANCELLED" || status === "TERMINATED" || status === "LOCAL_CANCELLED"

	const statusColor =
		isCompleted ? "green" :
		isFailed ? "red" :
		isCancelled ? "yellow" :
		"dim"

	// Sub-items don't need their own spinner/checkmark if parent is showing it
	const label = <Text color={isParentFinal ? statusColor : "dim"}>{item.label}</Text>

	// Snippet of text
	const snippet = item.text.replace(/\s+/g, " ").slice(0, 60) + (item.text.length > 60 ? "..." : "")

	return (
		<Box flexDirection="column" marginLeft={4}>
			<Box>
				<Text color="dim"> • </Text>
				{label}
				{isCompleted && item.audioDuration !== undefined && (
					<Text color="cyan">  → {item.audioDuration.toFixed(1)} s</Text>
				)}
				{isFailed && item.error && (
					<Text color="red">  → {item.error.message}</Text>
				)}
			</Box>

			{/* Show text snippet for running/finished/failed */}
			{!isCancelled && status !== "PENDING" && status !== "SUBMITTED" && status !== "IN_QUEUE" && (
				<Box flexDirection="column" marginLeft={2}>
					<Box>
						<Text color="dim">→ </Text>
						<Text color="dim">"{snippet}"</Text>
					</Box>
					{isCompleted && item.outputPath && (
						<Box>
							<Text color="dim">→ </Text>
							<Text color="gray" italic>{item.outputPath}</Text>
							<Text color="dim"> {(item.audio!.length / 1024).toFixed(1)}kb</Text>
						</Box>
					)}
				</Box>
			)}
		</Box>
	)
}

const BatchGroup = ({ index, total, items }: { index: number, total: number, items: TrackedItem<any>[] }) => {
	// Status checks
	const isFailed = items.some((i) => i.status === "FAILED" || i.status === "TIMED_OUT")
	const isCompleted = items.every((i) => i.status === "COMPLETED")
	const isCancelled = items.every((i) => i.status === "CANCELLED" || i.status === "TERMINATED" || i.status === "LOCAL_CANCELLED")
	const isFinal = isFailed || isCompleted || isCancelled

	const isRunning = items.some((i) => i.status === "IN_PROGRESS")
	const isQueued = !isFinal && !isRunning

	// Expansion logic: Only expand if IN_PROGRESS or FINAL
	const showItems = isFinal || isRunning

	// Header Logic
	let icon: any = "•"
	let color = "gray"
	let statusText = "queued"

	if (isRunning) {
		statusText = "RUNNING"
		color = "cyan"
		icon = <Spinner type="dots" />
	} else if (isFailed) {
		statusText = "FAILED"
		icon = "✖"
		color = "red"
	} else if (isCompleted) {
		statusText = "DONE"
		icon = "✔"
		color = "green"
	} else if (isCancelled) {
		statusText = "STOPPED"
		icon = "⊘"
		color = "yellow"
	} else if (isQueued) {
		const uniqueStatuses = Array.from(new Set(items.map(i => i.status)))
		if (uniqueStatuses.includes("IN_QUEUE") || uniqueStatuses.includes("SUBMITTED")) {
			statusText = "QUEUED"
			color = "magenta"
			icon = <Spinner type="dots" />
		} else {
			statusText = "PENDING"
		}
	}

	const elapsed = items.reduce((max, i) => Math.max(max, i.elapsed || 0), 0)
	const duration = elapsed > 0 ? `  ++ took ${(elapsed / 1000).toFixed(1)} s` : ""

	return (
		<Box flexDirection="column" marginBottom={isFinal ? 1 : 0}>
			<Box>
				<Text color={color}>{icon} </Text>
				<Text bold color={color}>Batch {index + 1}/{total}</Text>
				<Text color="dim"> [{statusText}]</Text>
				{isCompleted && <Text color="dim">{duration}</Text>}
			</Box>

			{showItems && (
				<Box flexDirection="column">
					{items.map((item, i) => (
						<ItemRow key={item.id} item={item} isParentFinal={isFinal} />
					))}
				</Box>
			)}
		</Box>
	)
}

const ProgressUI = ({ items, error, cancelling }: { items: TrackedItem<any>[], error?: Error, cancelling?: boolean }) => {
	// Group items by batch index
	const batches = new Map<number, TrackedItem<any>[]>()

	items.forEach(item => {
		const idx = item.batchIndex ?? 0
		if (!batches.has(idx)) batches.set(idx, [])
		batches.get(idx)!.push(item)
	})

	const sortedBatches = Array.from(batches.entries()).sort((a, b) => a[0] - b[0])
	const totalBatches = items.length > 0 ? (items[0]?.batchTotal ?? sortedBatches.length) : 0

	// Logic for Static vs Dynamic
	let lastDoneIndex = -1
	for (let i = 0; i < sortedBatches.length; i++) {
		const [_, batchItems] = sortedBatches[i]!
		// Batch is done if all items are final
		const isDone = batchItems.every(item =>
			item.status === "COMPLETED" ||
			item.status === "FAILED" ||
			item.status === "CANCELLED" ||
			item.status === "TERMINATED" ||
			item.status === "LOCAL_CANCELLED"
		)
		if (isDone) {
			lastDoneIndex = i
		} else {
			break
		}
	}

	const doneBatches = sortedBatches.slice(0, lastDoneIndex + 1)
	const activeBatches = sortedBatches.slice(lastDoneIndex + 1)

	// Stats
	const completed = items.filter(i => i.status === "COMPLETED").length
	const failed = items.filter(i => i.status === "FAILED").length
	const total = items.length

	return (
		<>
			<Static items={doneBatches}>
				{([idx, batchItems]) => (
					<Box key={idx} marginBottom={0}>
						<BatchGroup index={idx} total={totalBatches} items={batchItems} />
					</Box>
				)}
			</Static>

			<Box flexDirection="column" padding={1}>
				{activeBatches.map(([idx, batchItems]) => (
					<BatchGroup key={idx} index={idx} total={totalBatches} items={batchItems} />
				))}

				<Box marginTop={1} borderStyle="round" borderColor={cancelling ? "yellow" : failed > 0 ? "red" : completed === total ? "green" : "gray"} paddingX={1}>
					<Text>
						{cancelling ? <Text color="yellow" bold>Stopping... (Ctrl+C to force)  |  </Text> : null}
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
		</>
	)
}

// ── Wrapper ────────────────────────────────────────────────────────

export async function runWithUI<T>(
	client: RunPodClient,
	items: ItemRequest<T>[],
	options: RunAllOptions<T> = {}
): Promise<TrackedItem<T>[]> {
	return new Promise((resolve, reject) => {
		let unmountInk: () => void

		const Wrapper = () => {
			const [trackedItems, setTrackedItems] = useState<TrackedItem<T>[]>([])
			const [error, setError] = useState<Error>()
			const [cancelling, setCancelling] = useState(false)

			// AbortController for cancellation
			const controller = useMemo(() => new AbortController(), [])

			useInput((input, key) => {
				if (input === "c" && key.ctrl) {
					if (!cancelling) {
						setCancelling(true)
						controller.abort() // Stop new submissions (but executeAll allows polling to continue)
						client.cancelAll().catch((err) => {
							console.error("Failed to cancel all jobs:", err)
						})
					} else {
						// Force exit on second press
						if (unmountInk) unmountInk()
						process.exit(1)
					}
				}
			})

			useEffect(() => {
				let mounted = true

				client.runAll(items, {
					...options,
					signal: controller.signal,
					onInit: (initItems) => {
						if (mounted) setTrackedItems([...initItems])
					},
					onStatusChange: (item) => {
						if (!mounted) return
						setTrackedItems((prev) => prev.map(t => t.id === item.id ? item : t))
					},
				}).then((final) => {
					if (!mounted) return
					setTrackedItems([...final])
					// Give UI a moment to show final state (e.g. cancelled) then exit
					setTimeout(() => {
						if (unmountInk) unmountInk()
						resolve(final)
					}, 500)
				}).catch((err) => {
					if (mounted) setError(err)
					if (unmountInk) unmountInk()
					reject(err)
				})

				return () => {
					mounted = false
				}
			}, [])

			return <ProgressUI items={trackedItems} error={error} cancelling={cancelling} />
		}

		const { unmount } = render(<Wrapper />, { exitOnCtrlC: false })
		unmountInk = unmount
	})
}
