import { Box, render, Static, Text, useInput } from "ink"
import Spinner from "ink-spinner"
import { useEffect, useMemo, useState } from "react"
import type { RunPodClient } from "./client"
import { logErrorToFile } from "./logger"
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
					{isCompleted && item.outputPath && item.audio && (
						<Box>
							<Text color="dim">→ </Text>
							<Text color="gray" italic>{item.outputPath}</Text>
							<Text color="dim"> {(item.audio.length / 1024).toFixed(1)}kb</Text>
						</Box>
					)}
				</Box>
			)}
		</Box>
	)
}

const BatchGroup = ({ index, total, items, isGroupExpanded }: { index: number, total: number, items: TrackedItem<any>[], isGroupExpanded?: boolean }) => {
	// Status checks
	const isFailed = items.some((i) => i.status === "FAILED" || i.status === "TIMED_OUT")
	const isCompleted = items.every((i) => i.status === "COMPLETED")
	const isCancelled = items.every((i) => i.status === "CANCELLED" || i.status === "TERMINATED" || i.status === "LOCAL_CANCELLED")
	const isFinal = isFailed || isCompleted || isCancelled

	const isRunning = items.some((i) => i.status === "IN_PROGRESS")
	const isQueued = !isFinal && !isRunning

	// Expansion logic: Expand if Running, Failed, or Completed (reverted to original behavior per user request)
	const showItems = isFinal || (isRunning && isGroupExpanded)

	// Header Logic
	let icon: any = "•"
	let color = "gray"
	let statusText = "queued"

	if (isRunning) {
		statusText = "RUNNING ⏳"
		color = "cyan"
		icon = <Spinner type="dots" />
	} else if (isFailed) {
		statusText = "FAILED ✖"
		icon = "✖"
		color = "red"
	} else if (isCompleted) {
		statusText = "FINISHED ✅"
		icon = "✔"
		color = "green"
	} else if (isCancelled) {
		statusText = "STOPPED ⊘"
		icon = "⊘"
		color = "yellow"
	} else if (isQueued) {
		const uniqueStatuses = Array.from(new Set(items.map(i => i.status)))
		if (uniqueStatuses.includes("IN_QUEUE") || uniqueStatuses.includes("SUBMITTED")) {
			statusText = "QUEUED 📋"
			color = "magenta"
			icon = <Spinner type="dots" />
		} else {
			statusText = "PENDING ⌚"
		}
	}

	const elapsed = items.reduce((max, i) => Math.max(max, i.elapsed || 0), 0)
	const duration = elapsed > 0 ? ` took ${(elapsed / 1000).toFixed(1)}s` : ""

	return (
		<Box flexDirection="column" marginLeft={2}>
			<Box>
				<Text color={color}>{icon} </Text>
				<Text bold color={color}>Batch {index + 1}/{total}</Text>
				<Text color="dim"> [{statusText}]</Text>
				{isCompleted && <Text color="dim"> — {duration}</Text>}
			</Box>

			{showItems && (
				<Box flexDirection="column">
					{items.map((item) => (
						<ItemRow key={item.id} item={item} isParentFinal={isFinal} />
					))}
				</Box>
			)}
		</Box>
	)
}

const StoryGroup = ({ group, items }: { group: string, items: TrackedItem<any>[] }) => {
	// Group items by batch index
	const batches = new Map<number, TrackedItem<any>[]>()
	items.forEach(item => {
		const idx = item.batchIndex ?? 0
		if (!batches.has(idx)) batches.set(idx, [])
		batches.get(idx)!.push(item)
	})

	const sortedBatches = Array.from(batches.entries()).sort((a, b) => a[0] - b[0])
	const totalBatches = items.length > 0 ? (items[0]?.batchTotal ?? sortedBatches.length) : sortedBatches.length

	const totalChunks = items.length
	const completedChunks = items.filter(i => i.status === "COMPLETED").length
	const isDone = completedChunks === totalChunks && totalChunks > 0

	const isStarted = items.some(i => i.status !== "PENDING" && i.status !== "IN_QUEUE")

	// If not started, just show the header
	if (!isStarted) {
		return (
			<Box flexDirection="column" marginBottom={0}>
				<Text color="dim">{group} (waiting)</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text bold color={isDone ? "green" : "white"}>{group}</Text>
			{/* Only show chunk count if active/done */}
			<Box marginLeft={2}>
				<Text color="dim">→ {totalChunks} chunk(s)</Text>
			</Box>
			{sortedBatches.map(([idx, batchItems]) => (
				<BatchGroup key={idx} index={idx} total={totalBatches} items={batchItems} isGroupExpanded={!isDone} />
			))}
		</Box>
	)
}

const ProgressUI = ({ items, error, cancelling, cancelError }: { items: TrackedItem<any>[], error?: Error, cancelling?: boolean, cancelError?: Error }) => {
	// Group items by 'group' (Story)
	const groups = new Map<string, TrackedItem<any>[]>()
	// Fallback group for items without a group
	const DEFAULT_GROUP = "General"

	items.forEach(item => {
		const g = item.group ?? DEFAULT_GROUP
		if (!groups.has(g)) groups.set(g, [])
		groups.get(g)!.push(item)
	})

	const sortedGroups = Array.from(groups.entries())

	// 1. Identify "Done" groups for Static rendering
	// A group is done if ALL items are Final (Completed/Failed/Cancelled)
	// AND we have output paths for completed items (to ensure metadata is ready)
	let lastDoneIndex = -1
	for (let i = 0; i < sortedGroups.length; i++) {
		const [_, groupItems] = sortedGroups[i]!
		const isGroupDone = groupItems.every(item => {
			const isFinalStatus =
				item.status === "COMPLETED" ||
				item.status === "FAILED" ||
				item.status === "CANCELLED" ||
				item.status === "TERMINATED" ||
				item.status === "LOCAL_CANCELLED"

			if (!isFinalStatus) return false
			if (item.status === "COMPLETED" && !item.outputPath) return false
			return true
		})

		if (isGroupDone) {
			lastDoneIndex = i
		} else {
			break
		}
	}

	const doneGroups = sortedGroups.slice(0, lastDoneIndex + 1)
	const remainingGroups = sortedGroups.slice(lastDoneIndex + 1)

	// 2. Filter "Remaining" groups to show Active + First Pending
	const visibleActiveGroups: typeof sortedGroups = []
	let foundFirstPending = false

	for (const group of remainingGroups) {
		const [_, groupItems] = group
		const isStarted = groupItems.some(i => i.status !== "PENDING" && i.status !== "IN_QUEUE")

		if (isStarted) {
			visibleActiveGroups.push(group)
		} else {
			if (!foundFirstPending) {
				visibleActiveGroups.push(group)
				foundFirstPending = true
			}
			// Stop adding subsequent pending groups
		}
	}

	// Stats
	const completed = items.filter(i => i.status === "COMPLETED").length
	const failed = items.filter(i => i.status === "FAILED").length
	const total = items.length

	return (
		<>
			{/* Static Section for Completed Stories */}
			<Static items={doneGroups}>
				{([groupName, groupItems]) => (
					<Box key={groupName} marginBottom={1}>
						<StoryGroup group={groupName} items={groupItems} />
					</Box>
				)}
			</Static>

			{/* Active / Pending Section */}
			<Box flexDirection="column">
				{visibleActiveGroups.map(([groupName, groupItems]) => (
					<StoryGroup key={groupName} group={groupName} items={groupItems} />
				))}

				<Box borderStyle="round" borderColor={cancelling ? "yellow" : (failed > 0 || cancelError) ? "red" : completed === total ? "green" : "gray"} paddingX={1} marginTop={1}>
					<Text>
						{cancelling ? <Text color="yellow" bold>Stopping... (Ctrl+C to force)  |  </Text> : null}
						{cancelError ? <Text color="red" bold>Stop failed: {cancelError.message} (Ctrl+C to force)  |  </Text> : null}
						Total Strings: {total}  |
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
		const unmountRef = { current: () => {} }

		const Wrapper = ({ onUnmount }: { onUnmount: { current: () => void } }) => {
			const [trackedItems, setTrackedItems] = useState<TrackedItem<T>[]>([])
			const [error, setError] = useState<Error>()
			const [cancelling, setCancelling] = useState(false)
			const [cancelError, setCancelError] = useState<Error>()

			// AbortController for cancellation
			const controller = useMemo(() => new AbortController(), [])

			useInput((input, key) => {
				if (input === "c" && key.ctrl) {
					if (!cancelling) {
						setCancelling(true)
						setCancelError(undefined)
						controller.abort() // Stop new submissions (but executeAll allows polling to continue)
						client.cancelAll().catch((err) => {
							setCancelling(false)
							setCancelError(err instanceof Error ? err : new Error(String(err)))
							logErrorToFile("Failed to cancel all jobs", err)
						})
					} else {
						// Force exit on second press
						onUnmount.current()
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
						onUnmount.current()
						resolve(final)
					}, 500)
				}).catch((err) => {
					if (mounted) setError(err)
					onUnmount.current()
					reject(err)
				})

				return () => {
					mounted = false
				}
			}, [])

			return <ProgressUI items={trackedItems} error={error} cancelling={cancelling} cancelError={cancelError} />
		}

		const { unmount } = render(<Wrapper onUnmount={unmountRef} />, { exitOnCtrlC: false })
		unmountRef.current = unmount
	})
}
